# keyboxx

Give AI agents your API keys without them ever seeing the value.

```bash
keyboxx pull openai --as OPENAI_KEY --into .env
# added OPENAI_KEY (OpenAI, sk-***wxyz) in ./.env
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
# Key (paste it): sk-p***a3f2 (164 chars)
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

## Optional SSH sync

Local use needs no remote, SSH setup, or migration. Sync is an extra command you
run explicitly; `add`, `rm`, `list`, `pull`, and `run` never contact another machine.

Install a version of keyboxx with sync support on both machines, with `keyboxx`
available on the remote noninteractive SSH PATH. Set up SSH key authentication
and verify the host with a normal `ssh` login first. Sync uses your system `ssh`
client in batch mode, including host aliases, identities, ports and jump hosts
from `~/.ssh/config`.

```bash
keyboxx remote add server user@host
keyboxx sync status server
keyboxx sync push server --dry-run
keyboxx sync push server

# Later, to bring remote changes back:
keyboxx sync fetch server
```

Push and fetch copy the **whole credentials file**, including comments and
service/purpose metadata. Removing a key on the source removes it on the
destination at the next transfer. They do not merge keys or choose the newest
timestamp. Missing source files never erase a destination.

The first transfer can populate a missing or empty destination. Replacing a
different nonempty file needs `--force`. After a successful transfer, keyboxx
remembers the shared revision and refuses to overwrite destination changes.
Use `sync status` to review differing key names. If you intentionally want to
discard the destination's changes, run `sync push NAME --force` or
`sync fetch NAME --force`. This replaces the entire destination, including keys
that exist only there. `--force` still refuses concurrent changes during transfer.
`--dry-run` writes neither credentials nor a sync checkpoint.

Each machine keeps its own paths and configuration. By default the remote uses
its own configured credentials file. To choose another file:

```bash
keyboxx remote add staging staging-host --remote-file '~/.config/keyboxx/staging.env'
keyboxx sync push staging --env-file ~/my-staging-keys.env
keyboxx remote list
keyboxx remote rm staging
```

Remote definitions live in `remotes.json`, and shared revision hashes in
`sync-state.json`, inside the local keyboxx config directory. Neither file is
transferred. Removing a remote leaves credentials on both machines intact.
Sync output shows key names and summaries, never key values. Incoming credentials
are validated, written atomically with mode `600`, and serialized against other
keyboxx writes. If a process is forcibly terminated, it may leave a
`<filename>.keyboxx-lock` file; remove that lock only after ensuring no keyboxx
write is still running.

SSH encrypts the transfer. Credentials remain plaintext on both machines, with
the same access model as local keyboxx. Only sync to a host you trust with those
keys. There is no background sync or automatic backup of overwritten credentials.

## Not a vault

No encryption. keyboxx makes the safe path the easy one, but it won't stop an agent that runs `cat` on the file.

## License

[MPL-2.0](LICENSE)
