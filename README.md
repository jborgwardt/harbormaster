# Harbormaster

Settings, secrets and ports manager for umbrelOS, packaged as `heilss-harbormaster` in
[heil-store-studio](https://github.com/jborgwardt/heil-store-studio).

* **Dashboard** of every installed app: status, published host ports, containers.
* **Edit secrets / env** in a form. Saved through umbreld's own MCP API (`set_app_settings`
  → `customEnvironment`), i.e. umbrelOS's native per-app settings (`settings.yml` +
  `docker-compose.umbrel-user-settings.yml`), which umbreld re-applies on every start and app update.
  umbrelOS restarts the app.
* **Extra host ports** with conflict check. umbrelOS has no host-port override, so Harbormaster
  publishes small `alpine/socat` relay containers that it re-creates on start/every 5 min.
* **Private Gitea backup**: every save commits `apps/<app-id>/secret.env` and
  `apps/<app-id>/settings.json` to a private repo on your self-hosted Gitea. After a reinstall or on a
  new Umbrel, missing values are restored automatically (or via “Restore from Gitea”).
* **Public schemas**: a store app can ship `harbormaster.schema.json` (field names and descriptions,
  never values); Harbormaster shows those fields and flags missing required ones.

No secret values are ever in this repo or the public store.

Schema format:

```json
{"fields":[{"name":"ADDON_SHARED_SECRET","service":"server","required":true,"secret":true,"description":"..."}]}
```
