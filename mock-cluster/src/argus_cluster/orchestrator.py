"""Boots all 4 mock services on adjacent ports.

  api       :7101
  worker    :7102
  db_proxy  :7103
  auth      :7104
  cluster API surface :7100 (chaos control + health rollup)
"""
from __future__ import annotations
import multiprocessing as mp
import time
import uvicorn


def _run(app_module: str, port: int) -> None:
    uvicorn.run(app_module, host="0.0.0.0", port=port, log_level="info")


def main() -> None:
    services = [
        ("argus_cluster.api:app", 7101),
        ("argus_cluster.worker:app", 7102),
        ("argus_cluster.db_proxy:app", 7103),
        ("argus_cluster.auth:app", 7104),
        ("argus_cluster.gateway:app", 7100),
    ]
    procs = [mp.Process(target=_run, args=(m, p), daemon=False) for m, p in services]
    for p in procs:
        p.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        for p in procs:
            p.terminate()
        for p in procs:
            p.join()


if __name__ == "__main__":
    main()
