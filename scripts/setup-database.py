#!/usr/bin/env python3
"""Create SeaPro's isolated roles/database. Run as the repo owner with sudo access.
Passwords are passed over stdin and saved only in the ignored mode-0600 .env.
"""
import os, pathlib, secrets, subprocess
root = pathlib.Path(__file__).resolve().parent.parent
env = root / '.env'
current = env.read_text() if env.exists() else ''
if any(line.startswith('DATABASE_URL=') for line in current.splitlines()):
    raise SystemExit('DATABASE_URL already configured; refusing to replace credentials.')
app_password, maintenance_password = secrets.token_hex(32), secrets.token_hex(32)
def sql(text, db='postgres'):
    result=subprocess.run(['sudo','-n','-u','postgres','psql','-X','-v','ON_ERROR_STOP=1','-d',db],input=text,text=True,capture_output=True)
    if result.returncode:
        raise SystemExit('Database setup failed; check existing SeaPro roles/database. No credentials printed.')
sql(f"CREATE ROLE seapro_maintenance LOGIN PASSWORD '{maintenance_password}';\nCREATE ROLE seapro_app LOGIN PASSWORD '{app_password}';\nCREATE DATABASE seapro OWNER seapro_maintenance;\n")
sql("REVOKE CONNECT ON DATABASE seapro FROM PUBLIC; GRANT CONNECT ON DATABASE seapro TO seapro_app,seapro_maintenance; CREATE EXTENSION postgis; REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO seapro_app; ALTER DEFAULT PRIVILEGES FOR ROLE seapro_maintenance IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO seapro_app;",'seapro')
with env.open('a') as f:
    f.write(f'\nDATABASE_URL=postgresql://seapro_app:{app_password}@127.0.0.1:5432/seapro\nDATABASE_MAINTENANCE_URL=postgresql://seapro_maintenance:{maintenance_password}@127.0.0.1:5432/seapro\n')
os.chmod(env,0o600)
print('SeaPro database and isolated roles created; credentials saved to .env.')
