# @deepseek-ai/dsh-git-guard

Private tools/pre-execute gate for `bash` / `pwsh`: deny `git init` and force-push, deny push to `prd`, ask on other pushes.

```yaml
- name: '@deepseek-ai/dsh-git-guard'
```

Mounted from `dsh-base`. Does not replace GitLab protected branches. Classifier is best-effort over free-form shell text.
