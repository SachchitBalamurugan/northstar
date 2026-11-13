"""Windows shim for the Unix-only `fcntl` module.

universal-memory 0.6.4 imports fcntl once, to take a non-blocking lock on its
context-summary file. On Windows we map that onto msvcrt.locking, best effort,
so the CLI can start. Put this folder on PYTHONPATH only for umem subprocesses.
"""
import os
import sys

LOCK_SH = 1
LOCK_EX = 2
LOCK_NB = 4
LOCK_UN = 8

if sys.platform == "win32":
    import msvcrt

    def flock(fd: int, operation: int) -> None:  # noqa: D401
        try:
            pos = os.lseek(fd, 0, os.SEEK_CUR)
            os.lseek(fd, 0, os.SEEK_SET)
            try:
                if operation & LOCK_UN:
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                elif operation & LOCK_NB:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            finally:
                os.lseek(fd, pos, os.SEEK_SET)
        except OSError as exc:
            if operation & LOCK_NB and not operation & LOCK_UN:
                raise BlockingIOError(exc.errno, "lock unavailable") from exc
            # unlock failures and blocking-lock failures are ignored (best effort)
else:  # pragma: no cover
    from fcntl import flock  # type: ignore  # real module on Unix
