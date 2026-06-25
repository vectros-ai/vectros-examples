# Vectros CLI walkthrough

A short tour of the official Vectros CLI,
[`@vectros-ai/cli`](https://www.npmjs.com/package/@vectros-ai/cli) — manage API
keys, application contexts, access, and apply blueprints from your terminal.

Unlike the SDK examples (which authenticate with an API key), the CLI signs you
in interactively, so this is a guided walkthrough rather than an automated suite.

## Install and sign in

```bash
npm install -g @vectros-ai/cli
vectros login          # opens your browser to sign in
```

## A quick tour

```bash
vectros whoami         # the identity you're signed in as
vectros key list       # your API keys
vectros context list   # your application contexts
```

`demo.sh` runs exactly these read-only commands. After `vectros login`:

```bash
./demo.sh
```

## More

```bash
vectros --help                   # all commands
vectros key issue --help         # mint a scoped API key
vectros blueprint list           # browse the bundled blueprints
vectros bootstrap --help         # no-code: provision a blueprint + a scoped MCP credential
```

`vectros bootstrap --blueprint <name> --client code` provisions a blueprint and
wires the resulting credential into your MCP client in one step. It uses a
one-time bridge token from the developer portal — see the guide below.

Full CLI documentation and the no-code quickstart: **https://docs.vectros.ai**
