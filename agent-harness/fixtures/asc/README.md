# ASC static-analysis fixture

This fixture and its original smali/manifest sources were authored for DeepSonar
issue #754. They are dedicated to the public domain under CC0-1.0
(https://creativecommons.org/publicdomain/zero/1.0/). They contain no third-party
application code, secrets, network permission, Android components, or payload.
The unsigned APK is only a static-analysis input; do not install or execute it.

`classes.dex` defines `org.deepsonar.fixture.Primary`, and `classes2.dex` defines
`org.deepsonar.fixture.Secondary`. Both contain static references to Primary's
`ping` method, `marker` field, and type, plus distinct literal strings. The APK
also contains a genuine compiled binary AndroidManifest.xml. This allows testing
real APK parsing across two DEX files without relying on mocks or an unrelated
third-party APK.

Rebuild with Java 21 and the official apktool 3.0.3 jar:

```bash
curl -fL https://github.com/iBotPeaches/Apktool/releases/download/v3.0.3/apktool_3.0.3.jar -o /tmp/apktool.jar
python3 agent-harness/fixtures/asc/build.py /tmp/apktool.jar
```

The builder verifies the jar SHA-256 before execution, builds in a temporary
directory, and normalizes ZIP ordering, timestamps, compression and permissions.
`fixture.sha256` records the generated APK hash. The builder does not download
anything. apktool's bundled Android resource framework is used only to compile
the original manifest.

Run the real offline image acceptance test:

```bash
node agent-harness/test-asc-apk.mjs IMAGE linux/amd64 /tmp/asc-results
```

Use `linux/arm64` for that platform. The result records image identity and machine
architecture, but an arm64 run under QEMU is not native hardware validation.
Each invocation's arguments, exit status, stdout, stderr, and output file are
retained. Rust and Python pseudocode/formatting need not be byte-identical;
semantic checks and the recorded differences are separate from compatibility
claims. This small synthetic APK does not establish arbitrary APK compatibility
or performance.
