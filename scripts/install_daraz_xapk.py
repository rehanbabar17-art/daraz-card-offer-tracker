#!/usr/bin/env python3
"""Download, verify, and sideload the pinned official Daraz XAPK from APKPure."""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

DOWNLOAD_URL = (
    "https://d.apkpure.com/b/XAPK/com.daraz.android"
    "?versionCode=571&nc=arm64-v8a&sv=21"
)
EXPECTED_SHA256 = "f6f6d3b23d94151736a308525e08a9c4a4c30d58c64ff1eafb25605288d82736"
EXPECTED_CERT_SHA1 = "89abd17cc4543c48c7eb2ab0e4d70c04950dd47f"
EXPECTED_PACKAGE = "com.daraz.android"
EXPECTED_VERSION = "9.41.0"
EXPECTED_VERSION_CODE = "571"
USER_AGENT = "Mozilla/5.0 (compatible; DarazVoucherTracker/1.0)"
APK_FILES = [
    "com.daraz.android.apk",
    "config.arm64_v8a.apk",
    "config.mdpi.apk",
]


def open_range(url: str, start: int, end: int, timeout: int = 45):
    request = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT, "Range": f"bytes={start}-{end}"},
    )
    return urllib.request.urlopen(request, timeout=timeout)


def download_xapk(destination: Path) -> None:
    # The one-byte request follows APKPure's redirect and obtains its temporary
    # storage URL and total length without downloading the whole file at once.
    with open_range(DOWNLOAD_URL, 0, 0) as response:
        content_range = response.headers.get("Content-Range", "")
        if response.status != 206 or "/" not in content_range:
            raise RuntimeError(f"APKPure did not return a valid range response: {response.status}")
        resolved_url = response.geturl()
        total_size = int(content_range.rsplit("/", 1)[1])
        if response.read() != b"P":
            raise RuntimeError("APKPure response did not begin with an XAPK ZIP signature")

    chunk_size = 512 * 1024
    start = 0
    with destination.open("wb") as output:
        while start < total_size:
            end = min(start + chunk_size - 1, total_size - 1)
            expected_range = f"bytes {start}-{end}/{total_size}"
            for attempt in range(5):
                try:
                    with open_range(resolved_url, start, end) as response:
                        body = response.read()
                        actual_range = response.headers.get("Content-Range", "")
                        if (
                            response.status != 206
                            or actual_range != expected_range
                            or len(body) != end - start + 1
                        ):
                            raise RuntimeError(
                                f"Unexpected XAPK range at {start}: "
                                f"status={response.status}, range={actual_range}, bytes={len(body)}"
                            )
                    output.write(body)
                    output.flush()
                    start = end + 1
                    if start % (5 * 1024 * 1024) < chunk_size or start == total_size:
                        print(f"Downloaded Daraz XAPK: {start}/{total_size} bytes", flush=True)
                    break
                except Exception:
                    if attempt == 4:
                        raise
                    time.sleep(attempt + 1)

    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise RuntimeError(
            f"XAPK SHA-256 mismatch: expected {EXPECTED_SHA256}, received {digest}"
        )


def require_metadata(metadata: dict[str, Any]) -> None:
    expected = {
        "package_name": EXPECTED_PACKAGE,
        "version_name": EXPECTED_VERSION,
        "version_code": EXPECTED_VERSION_CODE,
    }
    for key, value in expected.items():
        if str(metadata.get(key)) != value:
            raise RuntimeError(f"XAPK metadata {key} mismatch: expected {value}, got {metadata.get(key)}")
    if metadata.get("split_apks") != [
        {"file": "com.daraz.android.apk", "id": "base"},
        {"file": "config.arm64_v8a.apk", "id": "config.arm64_v8a"},
        {"file": "config.mdpi.apk", "id": "config.mdpi"},
    ]:
        raise RuntimeError("XAPK split manifest differs from the pinned, verified APKPure package")


def signer_sha1(apk_path: Path, temp_dir: Path) -> str:
    with zipfile.ZipFile(apk_path) as apk:
        cert_files = [name for name in apk.namelist() if name.upper().startswith("META-INF/") and name.upper().endswith(".RSA")]
        if len(cert_files) != 1:
            raise RuntimeError(f"Expected one APK signing certificate in {apk_path.name}; found {len(cert_files)}")
        rsa_path = temp_dir / f"{apk_path.stem}.rsa"
        pem_path = temp_dir / f"{apk_path.stem}.pem"
        rsa_path.write_bytes(apk.read(cert_files[0]))

    subprocess.run(
        ["openssl", "pkcs7", "-inform", "DER", "-in", str(rsa_path), "-print_certs", "-out", str(pem_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    result = subprocess.run(
        ["openssl", "x509", "-in", str(pem_path), "-noout", "-fingerprint", "-sha1"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip().split("=", 1)[-1].replace(":", "").lower()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="daraz-xapk-") as temporary:
        root = Path(temporary)
        xapk_path = root / "daraz-9.41.0.xapk"
        download_xapk(xapk_path)

        with zipfile.ZipFile(xapk_path) as xapk:
            bad_entry = xapk.testzip()
            if bad_entry:
                raise RuntimeError(f"Corrupt XAPK archive entry: {bad_entry}")
            metadata = json.loads(xapk.read("manifest.json"))
            require_metadata(metadata)
            extracted: list[Path] = []
            for filename in APK_FILES:
                if filename not in xapk.namelist():
                    raise RuntimeError(f"Required XAPK split missing: {filename}")
                apk_path = root / filename
                apk_path.write_bytes(xapk.read(filename))
                extracted.append(apk_path)

        for apk_path in extracted:
            signer = signer_sha1(apk_path, root)
            if signer != EXPECTED_CERT_SHA1:
                raise RuntimeError(
                    f"Daraz signer mismatch for {apk_path.name}: "
                    f"expected {EXPECTED_CERT_SHA1}, received {signer}"
                )
        print("Verified APKPure XAPK hash, Daraz signing certificate, package and version.")

        abi_list = subprocess.run(
            ["adb", "shell", "getprop", "ro.product.cpu.abilist"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if "arm64-v8a" not in abi_list.split(","):
            raise RuntimeError(
                "Android emulator does not advertise ARM64 binary translation; "
                f"supported ABI list is {abi_list!r}"
            )

        subprocess.run(
            ["adb", "install-multiple", "-r", *(str(path) for path in extracted)],
            check=True,
        )
        installed = subprocess.run(
            ["adb", "shell", "pm", "path", EXPECTED_PACKAGE],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if "package:" not in installed:
            raise RuntimeError("Daraz installation returned success but package manager cannot find it")
        print(f"Installed {EXPECTED_PACKAGE} {EXPECTED_VERSION} from the verified APKPure XAPK.")


if __name__ == "__main__":
    main()
