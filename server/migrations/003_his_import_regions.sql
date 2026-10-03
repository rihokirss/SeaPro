CREATE TABLE his_import_regions (
  snapshot_id uuid NOT NULL REFERENCES his_snapshots(id) ON DELETE CASCADE,
  layer text NOT NULL,
  region_key text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, layer, region_key)
);
GRANT SELECT ON his_import_regions TO seapro_app;
REVOKE INSERT, UPDATE, DELETE ON his_import_regions FROM seapro_app;
