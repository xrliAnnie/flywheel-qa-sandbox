# Backend Test Suite — GeoForge3D

## API Configuration

- **Base URL**: Resolved via `gcloud run services describe` or default `https://geoforge3d-api-5csvf2blaa-uw.a.run.app`
- **Auth**: Service account via `gcloud auth print-identity-token`

## Default Test Suite

| # | Label | Style | Type | Config | Zoom | Address | Filter | Timeout |
|---|-------|-------|------|--------|------|---------|--------|---------|
| 1 | City PREVIEW | osm2world | PREVIEW | city_preview-v1 | 0.05 | Times Square, New York, NY | height_tagged | 600s |
| 2 | City FULL | osm2world | FULL | city_default-v1 | 0.05 | Times Square, New York, NY | buildings_highways | 1200s |
| 3 | Terrain PREVIEW | terrain_only | PREVIEW | terrain_default-v1 | 1.0 | Grand Canyon, AZ | - | 600s |
| 4 | Terrain FULL | terrain_only | FULL | terrain_default-v1 | 1.0 | Grand Canyon, AZ | - | 900s |

## Job Request Template

```json
{
  "address": "{address}",
  "product_style_id": "{style}",
  "product_size_id": "{type}",
  "zoom_factor": {zoom},
  "job_type": "{type}",
  "config_name": "{config}",
  "filter_strategy": "{filter}"
}
```

## Artifact Validation

| Artifact | Download | Validation | Min Size |
|----------|----------|-----------|----------|
| 3MF file | GCS bucket `gs://geoforge3d-artifacts-geoforge3d` | `unzip -t {file}` + check `3D/3dmodel.model` exists | Terrain PREVIEW: 50KB, Terrain FULL: 100KB, City PREVIEW: 100KB, City FULL: 500KB |

## Known Issues

- Terrain FULL jobs occasionally timeout at 900s under load — retry once before marking as infra_flake
- GLB validator requires Python 3.10+ (`shared/validators/glb_validator.py`)
