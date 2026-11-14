#!/usr/bin/env python3
"""Inject dsh-our-free-model into a snapshot.tar.xz (web+headless profiles).

Usage: python3 scripts/inject-our-free-model.py <snapshot.tar.xz> <out.tar.xz> <plugin_dir>
Disk-based (no whole-tar in RAM): extract -> copy payload -> patch cordis ->
repack with xz -T4. headless-bad negative-control profile is never touched.
"""
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PROFILES = ("web", "headless")
PKG = "dsh-our-free-model"
INSERT = "\n- insert:\n    - id: our-free-model\n      name: 'dsh-our-free-model'\n      config: {}\n"


def run(argv):
    print("+", " ".join(map(str, argv)), flush=True)
    subprocess.run([str(a) for a in argv], check=True)


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)
    src, dst, plugin_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    if not (plugin_dir / "index.js").exists() or not (plugin_dir / "package.json").exists():
        print(f"plugin payload incomplete in {plugin_dir}")
        sys.exit(1)
    work_root = Path.cwd() / ".tools"
    work_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ofm-inject-", dir=work_root) as td:
        runtime = Path(td) / "runtime"
        runtime.mkdir()
        run(["tar", "--no-same-owner", "-xJf", src, "-C", runtime])
        for prof in PROFILES:
            dest = runtime / f"home/.dsh/profiles/{prof}/node_modules/{PKG}"
            if dest.exists():
                shutil.rmtree(dest)
            shutil.copytree(
                plugin_dir, dest,
                ignore=shutil.ignore_patterns("__pycache__", "*.map"),
            )
            patch = runtime / f"home/.dsh/profiles/{prof}/cordis.patch.yml"
            text = patch.read_text(encoding="utf-8")
            if "our-free-model" not in text:
                patch.write_text(text.rstrip() + "\n" + INSERT, encoding="utf-8")
                print(f"patched {patch.relative_to(runtime)}")
            else:
                print(f"already patched {patch.relative_to(runtime)}")
        # Repack usr+home only (snapshot layout), private modes like first-build.
        tar_path = Path(td) / "snapshot.tar"
        tarfile_open(tar_path, runtime)
        with open(dst.with_suffix(".part"), "wb") as out:
            subprocess.run(["xz", "-T4", "-6", "-c", str(tar_path)], stdout=out, check=True)
        dst.with_suffix(".part").replace(dst)
    print(f"written: {dst}")


def tarfile_open(tar_path, runtime):
    import tarfile

    def private_mode(info):
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        if info.isdir():
            info.mode = 0o700
        elif info.isfile():
            with (runtime / info.name).open("rb") as f:
                prefix = f.read(4)
            info.mode = 0o700 if prefix.startswith((b"\x7fELF", b"#!")) else 0o600
        return info

    archive = tarfile.open(tar_path, "w", dereference=False)
    for directory in ("usr", "home"):
        archive.add(runtime / directory, arcname=directory, filter=private_mode)
    archive.close()
    return archive


if __name__ == "__main__":
    main()
