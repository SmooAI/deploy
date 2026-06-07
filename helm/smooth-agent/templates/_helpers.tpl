{{/*
Expand the name of the chart.
*/}}
{{- define "smooth-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "smooth-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "smooth-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "smooth-agent.labels" -}}
helm.sh/chart: {{ include "smooth-agent.chart" . }}
{{ include "smooth-agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "smooth-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "smooth-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "smooth-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "smooth-agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The name of the chart-managed Secret holding the gateway key / database URL.
*/}}
{{- define "smooth-agent.secretName" -}}
{{- printf "%s-secret" (include "smooth-agent.fullname" .) }}
{{- end }}

{{/*
Resolved Secret name + key for SMOOAI_GATEWAY_KEY.
Prefers an external secret ref; otherwise the chart-managed Secret.
*/}}
{{- define "smooth-agent.gatewayKeySecretName" -}}
{{- if .Values.gateway.keySecretRef.name }}{{ .Values.gateway.keySecretRef.name }}{{- else }}{{ include "smooth-agent.secretName" . }}{{- end }}
{{- end }}
{{- define "smooth-agent.gatewayKeySecretKey" -}}
{{- if .Values.gateway.keySecretRef.name }}{{ .Values.gateway.keySecretRef.key }}{{- else }}SMOOAI_GATEWAY_KEY{{- end }}
{{- end }}

{{/*
Resolved Secret name + key for the database URL (SMOOTH_AGENT_DATABASE_URL).
*/}}
{{- define "smooth-agent.databaseSecretName" -}}
{{- if .Values.database.urlSecretRef.name }}{{ .Values.database.urlSecretRef.name }}{{- else }}{{ include "smooth-agent.secretName" . }}{{- end }}
{{- end }}
{{- define "smooth-agent.databaseSecretKey" -}}
{{- if .Values.database.urlSecretRef.name }}{{ .Values.database.urlSecretRef.key }}{{- else }}SMOOTH_AGENT_DATABASE_URL{{- end }}
{{- end }}

{{/*
Whether the chart needs to create its own Secret (i.e. at least one inline
secret value is provided and no external ref overrides it).
*/}}
{{- define "smooth-agent.createSecret" -}}
{{- $needGateway := and .Values.gateway.key (not .Values.gateway.keySecretRef.name) -}}
{{- $needDb := and .Values.database.url (not .Values.database.urlSecretRef.name) -}}
{{- if or $needGateway $needDb }}true{{- end }}
{{- end }}
