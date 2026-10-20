# shellcheck shell=sh
# Platform image deployment contract (#740 P1 slice 3), sourced by deploy.sh.
#
# Scheduler / Web / image-admission are referenced by full immutable digest:
#   DEEPSONAR_SCHEDULER_IMAGE=<registry>/deepsonar-scheduler@sha256:<64 hex>
#   DEEPSONAR_WEB_IMAGE=<registry>/deepsonar-web@sha256:<64 hex>
#   DEEPSONAR_IMAGE_ADMISSION_IMAGE=<registry>/deepsonar-image-admission@sha256:<64 hex>
#   DEEPSONAR_VERSION=X.Y.Z   (the only source of /health.version)
# The removed DEEPSONAR_IMAGE_TAG and any mutable tag fail closed; there is no
# fallback to tags. Process env wins over deploy/.env (same as Compose).

DS_PLATFORM_IMAGE_SPECS="DEEPSONAR_SCHEDULER_IMAGE=deepsonar-scheduler DEEPSONAR_WEB_IMAGE=deepsonar-web DEEPSONAR_IMAGE_ADMISSION_IMAGE=deepsonar-image-admission"
DS_PLATFORM_VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'
DS_LOCAL_BUILD_TAG="local-build"

# ds_env_file_value FILE KEY — first KEY=value in FILE (CR / surrounding blanks trimmed).
ds_env_file_value() {
  [ -f "$1" ] || return 0
  awk -v k="$2" '
    { sub(/\r$/, "") }
    index($0, k "=") == 1 {
      v = substr($0, length(k) + 2)
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      print v
      exit
    }
  ' "$1"
}

# ds_effective_env_value FILE KEY — exported process env beats deploy/.env.
ds_effective_env_value() {
  eval "_ds_set=\${$2+x}"
  if [ -n "$_ds_set" ]; then
    eval "printf '%s\n' \"\$$2\""
    return 0
  fi
  ds_env_file_value "$1" "$2"
}

# Reject ambiguous dotenv syntax instead of validating a different value from
# Compose (which accepts export, whitespace, colon delimiters and last-wins keys).
ds_platform_env_file_unambiguous() {
  [ -f "$1" ] || return 0
  awk -v k="$2" '
    { sub(/\r$/, "") }
    $0 ~ "^[ \t]*(export[ \t]+)?" k "([ \t]*[=:]|[ \t]*$)" {
      count++
      if (index($0, k "=") != 1) bad=1
    }
    END { exit (count > 1 || bad) ? 1 : 0 }
  ' "$1"
}

ds_platform_image_ref_valid() {
  # ds_platform_image_ref_valid REF REPO_NAME
  printf '%s\n' "$1" | grep -Eq "^[a-z0-9][a-z0-9._:/-]*/$2@sha256:[0-9a-f]{64}\$"
}

ds_platform_contract_hint() {
  example="$1"
  echo "[deploy] 平台镜像已改为按不可变 digest 引用（#740），不再接受 DEEPSONAR_IMAGE_TAG 或可变 tag。" >&2
  echo "[deploy] 请删除 deploy/.env 中的 DEEPSONAR_IMAGE_TAG，并从与当前 Release 同步的 deploy/.env.example 复制以下行后重试：" >&2
  if [ -f "$example" ]; then
    grep -E '^(DEEPSONAR_VERSION|DEEPSONAR_SCHEDULER_IMAGE|DEEPSONAR_WEB_IMAGE|DEEPSONAR_IMAGE_ADMISSION_IMAGE)=' "$example" \
      | sed 's/^/  /' >&2 || true
  fi
  echo "[deploy] 不要删除整个 deploy/.env（其中保存数据库密码与密钥）；后续版本的 deploy.sh upgrade 会自动重新生成这些行。" >&2
}

# ds_check_platform_image_contract ENV_FILE ENV_EXAMPLE REQUIRE_PLATFORM(1|0)
# Returns non-zero (after printing every problem) when the contract is violated.
ds_check_platform_image_contract() {
  env_file="$1"
  example="$2"
  require="$3"
  bad=0
  if [ -f "$env_file" ] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?DEEPSONAR_IMAGE_TAG([[:space:]]*[=:]|[[:space:]]*$)' "$env_file"; then
    echo "[deploy] deploy/.env 含已删除的 DEEPSONAR_IMAGE_TAG（平台镜像不再按 tag 部署）" >&2
    bad=1
  fi
  if [ -n "${DEEPSONAR_IMAGE_TAG+x}" ]; then
    echo "[deploy] 进程环境含已删除的 DEEPSONAR_IMAGE_TAG，请 unset 后重试" >&2
    bad=1
  fi
  if [ "$require" = "1" ]; then
    for spec in DEEPSONAR_VERSION=version $DS_PLATFORM_IMAGE_SPECS; do
      key=${spec%%=*}
      if ! ds_platform_env_file_unambiguous "$env_file" "$key"; then
        echo "[deploy] $key must have at most one canonical KEY=value assignment in deploy/.env" >&2
        bad=1
      fi
    done
    for spec in $DS_PLATFORM_IMAGE_SPECS; do
      key=${spec%%=*}
      repo=${spec#*=}
      value=$(ds_effective_env_value "$env_file" "$key")
      if [ -z "$value" ]; then
        echo "[deploy] 缺少 $key（必须是 <registry>/$repo@sha256:<64 位小写 hex>）" >&2
        bad=1
      elif ! ds_platform_image_ref_valid "$value" "$repo"; then
        echo "[deploy] $key=$value 不是 $repo 的不可变 digest 引用（必须是 <registry>/$repo@sha256:<64 位小写 hex>，不接受 tag）" >&2
        bad=1
      fi
    done
    version=$(ds_effective_env_value "$env_file" DEEPSONAR_VERSION)
    if [ -z "$version" ]; then
      echo "[deploy] 缺少 DEEPSONAR_VERSION（/health.version 只认该变量，不再回退镜像 tag）" >&2
      bad=1
    elif ! printf '%s\n' "$version" | grep -Eq "$DS_PLATFORM_VERSION_RE"; then
      echo "[deploy] DEEPSONAR_VERSION=$version 必须是无 v 前缀的 X.Y.Z（可带 -/+ 后缀）" >&2
      bad=1
    fi
  fi
  if [ "$bad" -ne 0 ]; then
    ds_platform_contract_hint "$example"
    return 1
  fi
  return 0
}

# ds_export_local_build_platform_images — `up ... build` tags local builds with a
# plain name (Compose cannot tag a build as name@sha256:...).
ds_export_local_build_platform_images() {
  for spec in $DS_PLATFORM_IMAGE_SPECS; do
    key=${spec%%=*}
    repo=${spec#*=}
    eval "$key=\"$repo:$DS_LOCAL_BUILD_TAG\""
    # shellcheck disable=SC2163
    export "$key"
  done
}
