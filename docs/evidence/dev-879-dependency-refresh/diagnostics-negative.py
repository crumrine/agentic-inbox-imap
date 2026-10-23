# Copyright (c) 2026 Brian Crumrine
# SPDX-License-Identifier: Apache-2.0
# Run from the Inbox repository; mutate only a disposable exported checkout.
import json, os, pathlib, subprocess, tarfile, tempfile
root = pathlib.Path.cwd()
out = root.parent / "implementation-v4-evidence"
with tempfile.TemporaryDirectory(prefix="dev879-diagnostics-") as temp:
    target = pathlib.Path(temp)
    archive = subprocess.check_output(["git", "archive", "HEAD"])
    import io
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(target, filter="data")
    (target / "node_modules").symlink_to(root / "node_modules", target_is_directory=True)
    import shutil
    shutil.copy2(root / "worker-configuration.d.ts", target / "worker-configuration.d.ts")
    for name in ["workers/app.ts", "workers/index.ts", "workers/lib/raw-mime.ts"]:
        (target / name).write_bytes(subprocess.check_output(["git", "show", "b876506:" + name]))
    args = ["node", str(root / "node_modules/vitest/vitest.mjs"), "run", "test/inbound-diagnostics.test.ts", "--maxWorkers=1", "--testTimeout=30000", "--hookTimeout=30000"]
    with (out / "diagnostics-negative.log").open("w") as log:
        result = subprocess.run(args, cwd=target, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    log = (out / "diagnostics-negative.log").read_text()
    assert result.returncode == 1, result.returncode
    assert "8 failed" in log and "AssertionError" in log, log[-2000:]
    (out / "diagnostics-negative.json").write_text(json.dumps({"source": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(), "restoredCatchesFrom": "b87650673815a9a7236303457435bb33a0e1d4ac", "exit": result.returncode, "failedCases": 8, "assertionFailures": True}, indent=2) + "\n")
    print("All 8 diagnostics negative controls failed against original catches.")
