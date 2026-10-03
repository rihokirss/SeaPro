CREATE TABLE his_snapshots (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expected_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  actual_counts jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE his_features (
  snapshot_id uuid NOT NULL REFERENCES his_snapshots(id) ON DELETE CASCADE,
  layer text NOT NULL,
  feature_id text NOT NULL,
  properties jsonb NOT NULL,
  geom geometry(Geometry, 4326),
  PRIMARY KEY (snapshot_id, layer, feature_id)
);
CREATE INDEX his_features_geom_idx ON his_features USING gist (geom);

CREATE TABLE his_active_snapshot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  snapshot_id uuid NOT NULL REFERENCES his_snapshots(id)
);

GRANT SELECT ON his_snapshots, his_features, his_active_snapshot TO seapro_app;
REVOKE INSERT, UPDATE, DELETE ON his_snapshots, his_features, his_active_snapshot FROM seapro_app;
