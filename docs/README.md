# Documentation

| Document                                 | Contents                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ |
| [architecture.md](architecture.md)       | System topology, service boundaries, invariants, what exists today |
| [database.md](database.md)               | Privilege model, migrations, schema conventions, index strategy    |
| [deployment.md](deployment.md)           | Local stack, image construction, CI, the AWS target                |
| [security.md](security.md)               | Implemented controls, what each phase adds, known gaps             |
| [interview-notes.md](interview-notes.md) | Trade-offs, failure modes, bugs found, what is not claimed         |
| [decisions/](decisions/)                 | Architecture Decision Records                                      |

Each page describes code that exists. Where something is designed but not
built, it says so — see the gaps listed in `security.md` and the "what is not
claimed" section of `interview-notes.md`.
