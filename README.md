# keyboxx

Give AI agents your API keys without them ever seeing the value.

```bash
keyboxx pull openai --as OPENAI_KEY --into .env
# added OPENAI_KEY (OpenAI, sk-…wxyz) in ./.env
```

You store a key once with a service and purpose. The agent finds the variable name the project wants and writes the key under that name. It only sees a masked preview.

## Install

```bash
npm i -g github:benekreng/keyboxx
```

Node 18+. No dependencies.

## Add keys

```bash
keyboxx add
# Service (e.g. OpenAI): OpenAI
# Purpose (optional): side projects
# Key (input hidden):
```

Or pipe it: `pbpaste | keyboxx add --service OpenAI`

## Use keys

| Command | Does |
| --- | --- |
| `keyboxx list` | Services, purposes, masked previews |
| `keyboxx pull openai --as VAR` | Write a key into `./.env` as `VAR` |
| `keyboxx pull A=openai B=stripe` | Several at once |
| `keyboxx run VAR=openai -- cmd` | Run `cmd` with the key set, no file |
| `keyboxx get openai --raw` | Print it. Refuses without `--raw` |
| `keyboxx rm openai` | Remove a key |

Several keys for one service? Use the name from `keyboxx list` instead of the service.

## Teach your agent

```bash
keyboxx agents >> AGENTS.md   # or CLAUDE.md
```

## The file

`~/.config/keyboxx/credentials.env`, mode `600`. Plain dotenv, so it works anywhere:

```bash
uv run --env-file "$(keyboxx path)" app.py
docker compose --env-file "$(keyboxx path)" up
```

Already have one? `keyboxx use ~/path/to/.env`

## Not a vault

No encryption. keyboxx makes the safe path the easy one, but it won't stop an agent that runs `cat` on the file.

## License

[MPL-2.0](LICENSE)
