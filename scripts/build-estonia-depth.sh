#!/usr/bin/env bash
set -euo pipefail

# Maa- ja Ruumiameti WFS väljastab Transpordiameti HIS-i põhjal tehtud
# 1 : 10 000 sügavusjooned ja -punktid SHP-na Eesti L-EST97 koordinaatides.
# See skript teeb neist ühe brauseris vahemikupäringutega loetava PMTilesi.

readonly MAPSHAPER_VERSION='0.7.51'
readonly TIPPECANOE_VERSION='0.3.4'
readonly CONTOUR_URL='https://teenus.maaamet.ee/ows/horisontaalid?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:samasygavusjooned&outputFormat=SHAPEZIP'
readonly SOUNDING_URL='https://teenus.maaamet.ee/ows/horisontaalid?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:sygavuspunktid&outputFormat=SHAPEZIP'
readonly SURVEY_URL='https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer/9/query?f=geojson&where=1%20%3D%201&outFields=objectid&returnGeometry=true&outSR=4326&resultRecordCount=100000'

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_path=${1:-"$repo_root/web/public/data/estonia-depth.pmtiles"}
coverage_path=${2:-"$repo_root/server/src/data/estonia-depth-coverage.json"}
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT

for command_name in curl unzip npx; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Puuduv tööriist: %s\n' "$command_name" >&2
    exit 1
  fi
done

printf 'Laadin Maa- ja Ruumiameti sügavusvektorid...\n'
curl --fail --location --retry 3 --silent --show-error \
  "$CONTOUR_URL" --output "$work_dir/contours.zip"
curl --fail --location --retry 3 --silent --show-error \
  "$SOUNDING_URL" --output "$work_dir/soundings.zip"
curl --fail --location --retry 3 --silent --show-error \
  "$SURVEY_URL" --output "$work_dir/surveys.geojson"
unzip -q "$work_dir/contours.zip" -d "$work_dir/contours"
unzip -q "$work_dir/soundings.zip" -d "$work_dir/soundings"

printf 'Teisendan L-EST97 geomeetria WGS84 koordinaatidesse...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/contours/samasygavusjooned.shp" encoding=utf8 \
  -proj init=EPSG:3301 crs=EPSG:4326 \
  -rename-fields depth=SYGAVUS \
  -each 'depth=Number(depth)' \
  -filter-fields depth \
  -o format=geojson precision=0.0000001 "$work_dir/contours.geojson"
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/soundings/sygavuspunktid.shp" encoding=utf8 \
  -proj init=EPSG:3301 crs=EPSG:4326 \
  -rename-fields depth=SYGAVUS \
  -each 'depth=Number(depth)' \
  -filter-fields depth \
  -o format=geojson precision=0.0000001 "$work_dir/soundings.geojson"

# Samast HIS-ist pärit mõõtealade ühend on ametliku kihi katvusmask. Maski
# järgi lõikab API EMODneti jooned välja ainult sealt, kus Eesti ametlikud
# vektorid neid asendavad. 25% lihtsustus hoiab piiri lähisuumis täpse, kuid
# väldib kümnete tuhandete servade läbimist iga kontuuripäringu ajal.
printf 'Koostan HIS-i mõõtealadest ametliku katvusmaski...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/surveys.geojson" \
  -dissolve \
  -clean \
  -simplify 25% keep-shapes \
  -o format=geojson geojson-type=FeatureCollection precision=0.000001 \
  "$work_dir/estonia-depth-coverage.json"

printf 'Ehitan PMTilesi (z9-z14; lähisuumis kasutatakse vektori ülessuumimist)...\n'
npx --yes "@bikehopper/node-tippecanoe@$TIPPECANOE_VERSION" \
  --output="$work_dir/estonia-depth.pmtiles" \
  --force \
  --minimum-zoom=9 \
  --maximum-zoom=14 \
  --named-layer="depth_contours:$work_dir/contours.geojson" \
  --named-layer="depth_soundings:$work_dir/soundings.geojson" \
  --include=depth \
  --attribute-type=depth:float \
  --name='Estonia official depth contours and soundings' \
  --description='Maa- ja Ruumiamet 1:10 000; generated from Transpordiamet HIS depth soundings' \
  --attribution='Maa- ja Ruumiamet; Transpordiamet HIS' \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplify-only-low-zooms \
  --quiet

if [[ $(head -c 8 "$work_dir/estonia-depth.pmtiles") != 'PMTiles'$(printf '\003') ]]; then
  printf 'Viga: väljund ei ole PMTiles v3 arhiiv.\n' >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_path")"
mv -- "$work_dir/estonia-depth.pmtiles" "$output_path"
chmod 0644 "$output_path"
mkdir -p -- "$(dirname -- "$coverage_path")"
mv -- "$work_dir/estonia-depth-coverage.json" "$coverage_path"
chmod 0644 "$coverage_path"
printf 'Valmis: %s (%s)\n' "$output_path" "$(du -h "$output_path" | cut -f1)"
printf 'Katvusmask: %s (%s)\n' "$coverage_path" "$(du -h "$coverage_path" | cut -f1)"
