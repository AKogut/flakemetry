{{- define "flakemetry.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flakemetry.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "flakemetry.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "flakemetry.labels" -}}
helm.sh/chart: {{ include "flakemetry.chart" . }}
{{ include "flakemetry.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "flakemetry.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flakemetry.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "flakemetry.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "flakemetry.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "flakemetry.secretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "flakemetry.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* component image ref: (dict "root" $ "name" "flakemetry-api" "tag" "") */}}
{{- define "flakemetry.image" -}}
{{- $root := .root -}}
{{- $tag := .tag | default $root.Values.image.tag -}}
{{- printf "%s/%s/%s:%s" $root.Values.image.registry $root.Values.image.repository .name $tag -}}
{{- end -}}

{{/* Shared env referencing the secret; used by api, worker, web. */}}
{{- define "flakemetry.commonEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "flakemetry.secretName" . }}
      key: database-url
- name: FLAKEMETRY_S3_BUCKET
  value: {{ .Values.storage.bucket | quote }}
- name: FLAKEMETRY_S3_ENDPOINT
  value: {{ .Values.storage.endpoint | quote }}
- name: FLAKEMETRY_S3_REGION
  value: {{ .Values.storage.region | quote }}
- name: FLAKEMETRY_S3_FORCE_PATH_STYLE
  value: {{ .Values.storage.forcePathStyle | quote }}
- name: FLAKEMETRY_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "flakemetry.secretName" . }}
      key: s3-access-key-id
- name: FLAKEMETRY_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "flakemetry.secretName" . }}
      key: s3-secret-access-key
{{- end -}}
