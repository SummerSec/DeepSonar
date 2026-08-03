import { execFileSync } from "node:child_process";

const image = process.argv[2];
if (!image) throw new Error("usage: node test-maven-package.mjs <kali-image>");

const encode = (content) => Buffer.from(content, "utf8").toString("base64");
const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.deepsonar</groupId>
  <artifactId>maven-smoke</artifactId>
  <version>1.0.0</version>
  <properties>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.commons</groupId>
      <artifactId>commons-lang3</artifactId>
      <version>3.18.0</version>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.14.0</version>
        <configuration><release>8</release></configuration>
      </plugin>
    </plugins>
  </build>
</project>
`;
const source = `package com.deepsonar;

import org.apache.commons.lang3.StringUtils;

public final class Smoke {
  public static void main(String[] args) {
    System.out.print(StringUtils.defaultString("maven-ok"));
  }
}
`;
const command = [
  "set -eu",
  "rm -rf /tmp/maven-smoke /tmp/maven-repository",
  "mkdir -p /tmp/maven-smoke/src/main/java/com/deepsonar",
  `printf '%s' '${encode(pom)}' | base64 -d > /tmp/maven-smoke/pom.xml`,
  `printf '%s' '${encode(source)}' | base64 -d > /tmp/maven-smoke/src/main/java/com/deepsonar/Smoke.java`,
  "cd /tmp/maven-smoke",
  "mvn -q -Dmaven.repo.local=/tmp/maven-repository -DskipTests package",
  "test -f target/maven-smoke-1.0.0.jar",
  "jar tf target/maven-smoke-1.0.0.jar | grep -F 'com/deepsonar/Smoke.class'",
  "test \"$(java -cp target/classes com.deepsonar.Smoke)\" = maven-ok",
  "test ! -d /root/.m2",
].join(" && ");

execFileSync("docker", [
  "run", "--rm", "--network", "bridge", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "1", "--memory", "1g", "--pids-limit", "256", image, "sh", "-lc", command,
], { stdio: "inherit" });

console.log(`${image} Maven online package smoke passed`);
