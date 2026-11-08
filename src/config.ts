import type { LngLatBoundsLike, LngLatLike } from 'maplibre-gl';

/** Greater Brisbane, roughly Chermside (north) to Springwood (south). Keep in sync with fetchers/lib.mjs. */
export const BOUNDS: LngLatBoundsLike = [
  [152.85, -27.7],
  [153.25, -27.3],
];
export const HOME: { center: LngLatLike; zoom: number } = { center: [153.05, -27.49], zoom: 10.6 };

/** Relative to the page, so it works under the /bne-flood-watch/ GitHub Pages subpath. */
export const DATA_URL = (path: string) => `${import.meta.env.BASE_URL}data/${path}`;
export const STATIC_URL = (path: string) => `${import.meta.env.BASE_URL}static/${path}`;

export const BASEMAP = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const QSPATIAL = 'https://spatial-gis.information.qld.gov.au/arcgis/rest/services/FloodCheck';
/** ArcGIS MapServer export rendered as 256px web-mercator tiles; CORS is allowed by the server. */
export const arcgisTiles = (service: string) =>
  `${QSPATIAL}/${service}/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
