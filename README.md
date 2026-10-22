# keyboxx

Give AI agents your API keys without them ever seeing the value.

```bash
keyboxx pull OPENAI_API_KEY --into .env
# added OPENAI_API_KEY (sk-…wxyz) in ./.env
```

Your keys live in one plain dotenv file. Agents copy them where they're needed and see only a masked preview.

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
# Variable name [OPENAI_API_KEY]:
# Key (input hidden):
```

Or pipe it: `pbpaste | keyboxx add --service OpenAI`

## Use keys

| Command | Does |
| --- | --- |
| `keyboxx list` | Names and masked previews |
| `keyboxx pull NAME --into .env` | Write a key into an env file |
| `keyboxx pull NAME --as VAR` | Write it under another name |
| `keyboxx run NAME -- cmd` | Run `cmd` with the key set |
| `keyboxx get NAME --raw` | Print it. Refuses without `--raw` |
| `keyboxx rm NAME` | Remove a key |

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
