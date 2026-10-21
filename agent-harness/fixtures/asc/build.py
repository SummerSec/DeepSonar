#!/usr/bin/env python3
"""Build an unsigned static-analysis fixture with an already downloaded apktool."""
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
APKTOOL_SHA256 = "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423"
jar = Path(sys.argv[1]).resolve()
if hashlib.sha256(jar.read_bytes()).hexdigest() != APKTOOL_SHA256:
    raise SystemExit("Expected the pinned apktool 3.0.3 jar")
with tempfile.TemporaryDirectory(prefix="asc-fixture-") as directory:
    temporary = Path(directory)
    source = temporary / "source"
    shutil.copytree(ROOT / "source", source, ignore=shutil.ignore_patterns("build", "dist"))
    raw = temporary / "raw.apk"
    subprocess.run([
        "java", "-jar", str(jar), "b", "-p", str(temporary / "framework"),
        str(source), "-o", str(raw),
    ], check=True)
    destination = ROOT / "fixture.apk"
    with zipfile.ZipFile(raw) as apk, zipfile.ZipFile(destination, "w") as result:
        for name in sorted(apk.namelist()):
            if name.endswith("/"):
                continue
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_STORED
            entry.external_attr = 0o100644 << 16
            result.writestr(entry, apk.read(name))
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    (ROOT / "fixture.sha256").write_text(f"{digest}  fixture.apk\n")
    print(f"{digest}  {destination}")
