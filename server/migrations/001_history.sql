CREATE TABLE app_metadata (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE verification_points (id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE weather_observations (
 point_id text NOT NULL, observed_at timestamptz NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(point_id, observed_at)
);
CREATE INDEX ON weather_observations(observed_at);
CREATE TABLE weather_forecasts (
 point_id text NOT NULL, source_id text NOT NULL, captured_at timestamptz NOT NULL,
 valid_at timestamptz NOT NULL, lead_hours smallint NOT NULL, data jsonb NOT NULL,
 PRIMARY KEY(point_id, source_id, captured_at, lead_hours)
);
CREATE INDEX ON weather_forecasts(lead_hours, valid_at, point_id);
CREATE INDEX ON weather_forecasts(valid_at);
CREATE INDEX ON weather_forecasts(captured_at DESC);
CREATE TABLE usage_hours (hour timestamptz PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE ais_vessels (mmsi integer PRIMARY KEY, first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL, data jsonb NOT NULL);
CREATE TABLE ais_points (
 day date NOT NULL, mmsi integer NOT NULL, bucket timestamptz NOT NULL, reported_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL, lat double precision NOT NULL, lon double precision NOT NULL,
 sog double precision, cog double precision, heading double precision, nav_stat smallint, ship_type smallint, moving boolean NOT NULL,
 source text NOT NULL, sources text[] NOT NULL,
 CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180),
 PRIMARY KEY(day, mmsi, bucket)
) PARTITION BY RANGE(day);
CREATE INDEX ON ais_points(mmsi, reported_at);
CREATE TABLE ais_track_blocks (
 day date NOT NULL, mmsi integer NOT NULL, version smallint NOT NULL,
 point_count integer NOT NULL, checksum text NOT NULL, payload bytea NOT NULL,
 first_at timestamptz NOT NULL, last_at timestamptz NOT NULL,
 PRIMARY KEY(mmsi, day)
);
CREATE INDEX ON ais_track_blocks(day);
CREATE TABLE ais_heatmap (
 day date NOT NULL, mmsi integer NOT NULL, part integer NOT NULL, ship_type smallint NOT NULL,
 path geometry(GeometryM,4326) NOT NULL, distance_m double precision NOT NULL,
 moving_seconds double precision NOT NULL, stationary_seconds double precision NOT NULL,
 started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
 PRIMARY KEY(day,mmsi,part)
);
CREATE INDEX ON ais_heatmap USING gist(path);
CREATE INDEX ON ais_heatmap(ship_type,day);
CREATE TABLE history_jobs (day date PRIMARY KEY, aggregated_at timestamptz, packed_at timestamptz);
CREATE TABLE history_gaps (id text PRIMARY KEY, started_at timestamptz NOT NULL, ended_at timestamptz, reason text NOT NULL);
CREATE TABLE history_partitions (day date PRIMARY KEY);
-- App writes measurements; maintenance owns schema changes and archived aggregates.
REVOKE INSERT,UPDATE,DELETE ON schema_migrations,history_partitions,history_jobs,ais_track_blocks,ais_heatmap FROM seapro_app;
