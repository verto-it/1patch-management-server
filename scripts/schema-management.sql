create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  roles text[] not null,
  mfa_enabled boolean not null default false,
  mfa_secret text,
  recovery_code_hashes text[] not null default '{}',
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  last_login_country text,
  oauth_links jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists backend_nodes (
  id text primary key,
  name text not null,
  public_url text not null,
  region text,
  site text,
  status text not null,
  enrollment_token_hash text not null,
  last_seen_at timestamptz,
  version text,
  capacity jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists devices (
  id text primary key,
  tenant_id text not null,
  hostname text not null,
  os text not null,
  public_key text not null,
  last_seen_at timestamptz,
  preferred_node_id text,
  created_at timestamptz not null default now()
);

create table if not exists installed_apps (
  id bigserial primary key,
  device_id text not null,
  name text not null,
  publisher text not null,
  version text not null,
  package_id text,
  product_code text
);

create index if not exists installed_apps_device_id_idx on installed_apps(device_id);
create index if not exists installed_apps_name_idx on installed_apps(name);

create table if not exists package_artifacts (
  id text primary key,
  name text not null,
  publisher text not null,
  version text not null,
  architecture text not null,
  platform text not null,
  type text not null,
  package_id text,
  file_name text,
  storage_path text,
  source_url text,
  sha256 text not null,
  signature_status text not null,
  install_args text not null,
  uninstall_args text,
  applicability jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists package_artifacts_name_version_idx on package_artifacts(name, version);

create table if not exists patch_rules (
  id text primary key,
  name text not null,
  enabled boolean not null default true,
  property text not null,
  operator text not null,
  value text not null,
  target_version text not null,
  max_version text,
  created_at timestamptz not null default now()
);

create table if not exists update_tasks (
  id text primary key,
  node_id text not null,
  device_id text not null,
  app_name text,
  package_artifact_id text,
  package_id text,
  product_code text,
  source_url text,
  sha256 text,
  install_args text,
  target_version text not null,
  type text not null,
  status text not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  output text
);

create index if not exists update_tasks_node_status_idx on update_tasks(node_id, status);
create index if not exists update_tasks_device_idx on update_tasks(device_id);

create table if not exists alarms (
  id text primary key,
  device_id text,
  severity text not null,
  message text not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  metadata jsonb not null default '{}'
);

create table if not exists audit_events (
  id text primary key,
  actor text not null,
  action text not null,
  target text,
  ip text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'
);
