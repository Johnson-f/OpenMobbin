# Output contract

Eagle owns every WebP. The repository owns only deterministic JSON metadata and ignored SQLite state.

Each asset identity is:

```text
<full-sha256>:<one-based-screen-position>
```

Visible Eagle names are:

```text
Apps/<app>/<NNN — flow>/<NNN — hash12>
Flows/<flow-group>/<app> — <NNN — flow>/<NNN — hash12>
```

For iOS, `<app>` is the source slug. For web, it is the source slug plus `-web`, including in `catalog/apps/<app>/`. The source Mobbin URL retains its original slug and platform. A catalog name cannot switch Mobbin app ID or platform during an update.

A successful command must satisfy:

- every current catalog reference resolves to one Eagle item;
- each item hash and position match its identity;
- both expected leaf memberships exist;
- leaves sort by ascending name;
- `_Mobbin Staging` is empty after completion;
- catalog JSON is valid and deterministic;
- SQLite integrity and rebuild checks pass;
- no project-owned WebP exists in the repository.
