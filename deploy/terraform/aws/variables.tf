variable "name" {
  description = "Prefix for every resource, and the RDS instance identifier."
  type        = string
  default     = "flakemetry"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,40}$", var.name))
    error_message = "name is lowercase letters, digits and hyphens, starting with a letter, at most 41 characters."
  }
}

variable "vpc_id" {
  description = "VPC the database lives in, normally the one the Kubernetes cluster runs in."
  type        = string
}

variable "database_subnet_ids" {
  description = "Private subnets for the database, in at least two availability zones."
  type        = list(string)

  validation {
    condition     = length(var.database_subnet_ids) >= 2
    error_message = "RDS needs subnets in at least two availability zones."
  }
}

variable "allowed_security_group_ids" {
  description = "Security groups allowed to reach Postgres, such as the EKS node or cluster security group."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.allowed_security_group_ids) + length(var.allowed_cidr_blocks) > 0
    error_message = "Name at least one security group or CIDR block that may reach the database; otherwise nothing can."
  }
}

variable "allowed_cidr_blocks" {
  description = "CIDR blocks allowed to reach Postgres, for clients without a security group."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for block in var.allowed_cidr_blocks : can(cidrhost(block, 0)) && block != "0.0.0.0/0"])
    error_message = "allowed_cidr_blocks must be valid CIDR blocks, and not 0.0.0.0/0."
  }
}

variable "database" {
  description = "RDS for PostgreSQL settings."
  type = object({
    instance_class           = optional(string, "db.t4g.medium")
    engine_version           = optional(string, "16")
    allocated_storage_gb     = optional(number, 20)
    max_allocated_storage_gb = optional(number, 200)
    multi_az                 = optional(bool, false)
    backup_retention_days    = optional(number, 7)
    deletion_protection      = optional(bool, true)
    performance_insights     = optional(bool, false)
    db_name                  = optional(string, "flakemetry")
    username                 = optional(string, "flakemetry")
  })
  default = {}

  validation {
    condition     = can(regex("^16(\\.|$)", var.database.engine_version))
    error_message = "Flakemetry is built and tested against PostgreSQL 16."
  }

  validation {
    condition     = var.database.backup_retention_days >= 1
    error_message = "Postgres is the system of record; keep at least one day of automated backups."
  }
}

variable "database_ca_bundle_url" {
  description = "Where to fetch the CA bundle that signs RDS certificates. The pods trust it so the connection verifies the server."
  type        = string
  default     = "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem"
}

variable "bucket_name" {
  description = "Artifact bucket name. Defaults to <name>-artifacts-<account>-<region>."
  type        = string
  default     = null
}

variable "web_origins" {
  description = "Dashboard origins allowed to read artifacts from the browser, such as https://flakemetry.example.com."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for origin in var.web_origins : can(regex("^https?://[^/]+$", origin))])
    error_message = "An origin is a scheme and a host, with no path or trailing slash."
  }
}

variable "artifact_expiration_days" {
  description = "Delete artifacts older than this from the bucket. Leave null: the worker already prunes by each project's retention policy, and a shorter bucket rule would override a project that keeps them longer."
  type        = number
  default     = null
}

variable "kms_key_arn" {
  description = "Customer-managed KMS key for the bucket. Null uses S3-managed keys."
  type        = string
  default     = null
}

variable "eks_oidc_provider_arn" {
  description = "IAM OIDC provider of an EKS cluster. When set, the api, worker and web reach S3 through an IAM role for their service account instead of access keys."
  type        = string
  default     = null
}

variable "kubernetes_namespace" {
  description = "Namespace the Helm release is installed in, for the IAM role's trust policy."
  type        = string
  default     = "flakemetry"
}

variable "kubernetes_service_account" {
  description = "Service account the chart creates, <release>-flakemetry by default."
  type        = string
  default     = "flakemetry"
}

variable "tags" {
  description = "Tags added to every resource."
  type        = map(string)
  default     = {}
}
