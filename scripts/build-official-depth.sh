#!/usr/bin/env bash
set -euo pipefail

# Koostab Maa- ja Ruumiameti ning Traficomi ametlikest vektoritest ühe
# brauseris HTTP Range päringutega loetava PMTilesi. Mõlema riigi andmed
# lõigatakse Eesti ametliku merepiiri järgi lahku, et piiril ei tekiks
# kattuvaid jooni. EMODneti serveripoolse lõikuse jaoks valmib eraldi
# ühendatud katvusmask.

readonly MAPSHAPER_VERSION='0.7.51'
readonly TIPPECANOE_VERSION='0.3.4'
readonly EE_CONTOUR_URL='https://teenus.maaamet.ee/ows/horisontaalid?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:samasygavusjooned&outputFormat=SHAPEZIP'
readonly EE_SOUNDING_URL='https://teenus.maaamet.ee/ows/horisontaalid?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:sygavuspunktid&outputFormat=SHAPEZIP'
readonly EE_SURVEY_URL='https://gis.transpordiamet.ee/arcgis/rest/services/Nutimeri/HIS/MapServer/9/query?f=geojson&where=1%20%3D%201&outFields=objectid&returnGeometry=true&outSR=4326&resultRecordCount=100000'
readonly EE_BOUNDARY_URL='https://teenus.maaamet.ee/ows/ajakohane-haldusjaotus?service=WFS&version=2.0.0&request=GetFeature&typeNames=ms:maakond_merel&outputFormat=SHAPEZIP'
readonly FI_WFS='https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs'
readonly FI_CONTOUR_URL="$FI_WFS?service=WFS&version=2.0.0&request=GetFeature&typeNames=rajoitettu%3ADepthContour_L&outputFormat=SHAPE-ZIP&count=1000000"
readonly FI_SOUNDING_URL="$FI_WFS?service=WFS&version=2.0.0&request=GetFeature&typeNames=rajoitettu%3ASounding_P&outputFormat=SHAPE-ZIP&count=1000000"
# Ainult geomeetria: muidu paisutab 149 457 sügavusala atribuudtabel
# vaheväljundi tarbetult veel sadade megabaitide võrra.
readonly FI_COVERAGE_URL="$FI_WFS?service=WFS&version=2.0.0&request=GetFeature&typeNames=rajoitettu%3ADepthArea_A&propertyName=GEOM&outputFormat=SHAPE-ZIP&count=1000000"

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output_path=${1:-"$repo_root/web/public/data/official-depth.pmtiles"}
coverage_path=${2:-"$repo_root/server/src/data/official-depth-coverage.json"}
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT

for command_name in curl unzip npx; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Puuduv tööriist: %s\n' "$command_name" >&2
    exit 1
  fi
done

download() {
  local label=$1
  local url=$2
  local destination=$3
  printf 'Laadin %s...\n' "$label"
  curl --fail --location --retry 3 --silent --show-error \
    "$url" --output "$destination"
}

download 'Eesti samasügavusjooned' "$EE_CONTOUR_URL" "$work_dir/ee-contours.zip"
download 'Eesti sügavuspunktid' "$EE_SOUNDING_URL" "$work_dir/ee-soundings.zip"
download 'Eesti HIS-i mõõtealad' "$EE_SURVEY_URL" "$work_dir/ee-surveys.geojson"
download 'Eesti ametliku merepiiri' "$EE_BOUNDARY_URL" "$work_dir/ee-boundary.zip"
download 'Soome samasügavusjooned' "$FI_CONTOUR_URL" "$work_dir/fi-contours.zip"
download 'Soome sügavuspunktid' "$FI_SOUNDING_URL" "$work_dir/fi-soundings.zip"
download 'Soome sügavusalad' "$FI_COVERAGE_URL" "$work_dir/fi-coverage.zip"

for archive in ee-contours ee-soundings ee-boundary fi-contours fi-soundings fi-coverage; do
  mkdir -p -- "$work_dir/$archive"
  unzip -q "$work_dir/$archive.zip" -d "$work_dir/$archive"
done

printf 'Koostan Eesti ametliku merepiiri...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/ee-boundary/maakond_merel.shp" encoding=utf8 \
  -dissolve \
  -proj init=EPSG:3301 crs=EPSG:4326 \
  -o format=geojson geojson-type=FeatureCollection precision=0.000001 \
  "$work_dir/ee-maritime-boundary.geojson"

printf 'Teisendan ja lõikan Eesti ametlikud sügavusvektorid...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/ee-contours/samasygavusjooned.shp" encoding=utf8 \
  -proj init=EPSG:3301 crs=EPSG:4326 \
  -clip "$work_dir/ee-maritime-boundary.geojson" \
  -rename-fields depth=SYGAVUS \
  -each 'depth=Number(depth);country="EE"' \
  -filter-fields depth,country \
  -o format=geojson precision=0.0000001 "$work_dir/ee-contours.geojson"
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/ee-soundings/sygavuspunktid.shp" encoding=utf8 \
  -proj init=EPSG:3301 crs=EPSG:4326 \
  -clip "$work_dir/ee-maritime-boundary.geojson" \
  -rename-fields depth=SYGAVUS \
  -each 'depth=Number(depth);country="EE"' \
  -filter-fields depth,country \
  -o format=geojson precision=0.0000001 "$work_dir/ee-soundings.geojson"

printf 'Koostan Eesti ja Soome ühendatud katvusmaski...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/ee-surveys.geojson" \
  -dissolve \
  -clean \
  -clip "$work_dir/ee-maritime-boundary.geojson" \
  -simplify 25% keep-shapes \
  -o format=geojson geojson-type=FeatureCollection precision=0.000001 \
  "$work_dir/ee-coverage.geojson"

# DepthArea_A sisaldab ka Soome siseveekogusid. Pärast dissolve/explode'i on
# Läänemerega ühendatud komponent üle 10 000 km², kõik järved sellest väiksemad.
# 0,1% lihtsustus jätab ranna ja saarestiku jaoks kümneid tuhandeid tippe, kuid
# teeb maski serveris iga kaardipäringu ajal kasutatavaks.
NODE_OPTIONS=--max-old-space-size=6144 npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/fi-coverage/DepthArea_APolygon.shp" \
  -dissolve \
  -clean \
  -explode \
  -filter 'this.area > 10000000000' \
  -simplify 0.1% keep-shapes \
  -proj crs=EPSG:4326 \
  -erase "$work_dir/ee-maritime-boundary.geojson" \
  -o format=geojson geojson-type=FeatureCollection precision=0.000001 \
  "$work_dir/fi-coverage.geojson"

npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  -i "$work_dir/ee-coverage.geojson" "$work_dir/fi-coverage.geojson" combine-files \
  -merge-layers force \
  -dissolve \
  -clean \
  -simplify 50% keep-shapes \
  -o format=geojson geojson-type=FeatureCollection precision=0.000001 \
  "$work_dir/official-depth-coverage.json"

# Traficomi samad lähtekihid sisaldavad ka Soome järvi. DepthArea_A-st
# eraldatud Läänemere komponent eemaldab siseveed ning juba sellest maha
# lõigatud Eesti merepiir tagab riikide vahel üheainsa ametliku allika.
printf 'Teisendan ja lõikan Soome ametlikud merevektorid...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/fi-contours/DepthContour_LLine.shp" encoding=utf8 \
  -proj crs=EPSG:4326 \
  -clip "$work_dir/fi-coverage.geojson" \
  -rename-fields depth=VALDCO \
  -each 'depth=Number(depth);country="FI"' \
  -filter-fields depth,country \
  -o format=geojson precision=0.0000001 "$work_dir/fi-contours.geojson"
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  "$work_dir/fi-soundings/Sounding_PPoint.shp" encoding=utf8 \
  -proj crs=EPSG:4326 \
  -clip "$work_dir/fi-coverage.geojson" \
  -rename-fields depth=DEPTH \
  -each 'depth=Number(depth);country="FI"' \
  -filter-fields depth,country \
  -o format=geojson precision=0.0000001 "$work_dir/fi-soundings.geojson"

printf 'Liidan mõlema riigi lähtekihid...\n'
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  -i "$work_dir/ee-contours.geojson" "$work_dir/fi-contours.geojson" combine-files \
  -merge-layers force \
  -o format=geojson precision=0.0000001 "$work_dir/contours.geojson"
npx --yes "mapshaper@$MAPSHAPER_VERSION" \
  -i "$work_dir/ee-soundings.geojson" "$work_dir/fi-soundings.geojson" combine-files \
  -merge-layers force \
  -o format=geojson precision=0.0000001 "$work_dir/soundings.geojson"

printf 'Ehitan ühise PMTilesi (z7-z12; lähisuumis vektori ülessuumimine)...\n'
npx --yes "@bikehopper/node-tippecanoe@$TIPPECANOE_VERSION" \
  --output="$work_dir/official-depth.pmtiles" \
  --force \
  --minimum-zoom=7 \
  --maximum-zoom=12 \
  --named-layer="depth_contours:$work_dir/contours.geojson" \
  --named-layer="depth_soundings:$work_dir/soundings.geojson" \
  --include=depth \
  --include=country \
  --attribute-type=depth:float \
  --name='Estonia and Finland official depth contours and soundings' \
  --description='Official display vectors from Maa- ja Ruumiamet / Transpordiamet HIS and Traficom' \
  --attribution='Maa- ja Ruumiamet; Transpordiamet HIS; Finnish Transport and Communications Agency Traficom' \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplify-only-low-zooms \
  --quiet

if [[ $(head -c 8 "$work_dir/official-depth.pmtiles") != 'PMTiles'$(printf '\003') ]]; then
  printf 'Viga: väljund ei ole PMTiles v3 arhiiv.\n' >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$output_path")"
mv -- "$work_dir/official-depth.pmtiles" "$output_path"
chmod 0644 "$output_path"
mkdir -p -- "$(dirname -- "$coverage_path")"
mv -- "$work_dir/official-depth-coverage.json" "$coverage_path"
chmod 0644 "$coverage_path"
printf 'Valmis: %s (%s)\n' "$output_path" "$(du -h "$output_path" | cut -f1)"
printf 'Katvusmask: %s (%s)\n' "$coverage_path" "$(du -h "$coverage_path" | cut -f1)"
