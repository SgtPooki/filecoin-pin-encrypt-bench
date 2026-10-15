**CONFIRMED, with one qualification.** I could not refute the bug, importer consequence, or Kubo error.

[Full verdict, exact commands, outputs, and minimal reproduction](investigation/VERDICT.md)

- BigInt is correct; numbers throw.
- The 1025 MiB import passes. The 3,891,799,298-byte import reproduces the supplied root’s malformed UnixFS Data.
- Kubo 0.43.1 independently rejects both with the reported error.
- Each affected field leaves four bytes unwritten; they retain actual allocation-pool contents.
- The overstatement: untouched bytes can accidentally contain the correct encoding. The underwrite is universal in the affected range; malformed output is not.
- Whether a newer release fixes it remains unresolved: npm registry access failed.