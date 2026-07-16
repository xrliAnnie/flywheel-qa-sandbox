# FLY-1262 SSOT discovery fixtures

These files model authoritative inputs, not a production dashboard data list.
Tests replace `/__FLY1262_PROJECT_ROOT__` with their temporary root before
loading them.

- `projects.json` registers one project and Lead.
- `project-config.yaml` declares one role through the real config shape.
- `com.xiaorongli.weee-weekly.plist` deliberately uses an arbitrary label and
  `/bin/bash` as argv0; the project-owned script is argv1.

The fixtures contain no tokens, environment values, or host-specific paths.
