# Local n8n login (this computer only)

**Author:** Hasan Gaffar

> Demo login of the author's own local installation. It works only on that computer. A new
> installation asks you to create your own account. Do not use this password anywhere else.
> Git ignores other files placed in `private/`.

| | |
|---|---|
| URL | http://localhost:5678 |
| Workflow | http://localhost:5678/workflow/BankStmtVerifier1 |
| Email | admin@localhost.local |
| Password | Bsv-3e05a7d8cfda144a-A1 |

The server listens on 127.0.0.1 only, so other machines cannot reach it.

## Where to look after logging in

- **Editor**: the workflow design.
- **Executions** tab: every request, node by node.
- **Data tables** (on the Personal home page): `statement_audit_log`, one row per request.

## Start the server again (after a restart of the computer)

The test installation lives in a temporary folder that a reboot can clear. For a permanent setup run
`npx n8n` with Node 22, then import `workflows/bank-statement-verifier.json` as described in the README.
A new installation asks you to create a new account.
