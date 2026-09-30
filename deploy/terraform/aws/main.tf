data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

locals {
  region      = data.aws_region.current.region
  bucket_name = coalesce(var.bucket_name, "${var.name}-artifacts-${data.aws_caller_identity.current.account_id}-${local.region}")
  use_irsa    = var.eks_oidc_provider_arn != null
  tags        = merge({ "app.kubernetes.io/part-of" = "flakemetry" }, var.tags)
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.database_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "Postgres for Flakemetry"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "from_security_groups" {
  for_each = toset(var.allowed_security_group_ids)

  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "Postgres from ${each.value}"
}

resource "aws_vpc_security_group_ingress_rule" "from_cidr_blocks" {
  for_each = toset(var.allowed_cidr_blocks)

  security_group_id = aws_security_group.database.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
  description       = "Postgres from ${each.value}"
}

resource "random_password" "database" {
  length  = 40
  special = false
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.database.engine_version
  instance_class = var.database.instance_class

  db_name  = var.database.db_name
  username = var.database.username
  password = random_password.database.result
  port     = 5432

  allocated_storage     = var.database.allocated_storage_gb
  max_allocated_storage = var.database.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false
  multi_az               = var.database.multi_az

  iam_database_authentication_enabled = true
  ca_cert_identifier                  = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.database.backup_retention_days
  copy_tags_to_snapshot     = true
  deletion_protection       = var.database.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  auto_minor_version_upgrade   = true
  performance_insights_enabled = var.database.performance_insights

  tags = local.tags
}

data "http" "database_ca_bundle" {
  url = var.database_ca_bundle_url

  lifecycle {
    postcondition {
      condition     = self.status_code == 200 && strcontains(self.response_body, "BEGIN CERTIFICATE")
      error_message = "The RDS CA bundle could not be fetched from ${var.database_ca_bundle_url}."
    }
  }
}

resource "aws_s3_bucket" "artifacts" {
  bucket = local.bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  dynamic "rule" {
    for_each = var.artifact_expiration_days == null ? [] : [var.artifact_expiration_days]

    content {
      id     = "expire-artifacts"
      status = "Enabled"

      filter {}

      expiration {
        days = rule.value
      }
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "artifacts" {
  count  = length(var.web_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.artifacts.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = var.web_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag", "Content-Length", "Content-Type"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "tls_only" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.tls_only.json

  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

data "aws_iam_policy_document" "artifacts_access" {
  statement {
    sid       = "ListArtifacts"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    sid       = "ReadWriteArtifacts"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == null ? [] : [var.kms_key_arn]

    content {
      sid       = "UseBucketKey"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

data "aws_iam_policy_document" "assume_from_service_account" {
  count = local.use_irsa ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.eks_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = ["system:serviceaccount:${var.kubernetes_namespace}:${var.kubernetes_service_account}"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

locals {
  oidc_issuer = local.use_irsa ? replace(var.eks_oidc_provider_arn, "/^arn:aws[a-z-]*:iam::[0-9]+:oidc-provider\\//", "") : null
}

resource "aws_iam_role" "artifacts" {
  count = local.use_irsa ? 1 : 0

  name               = "${var.name}-artifacts"
  assume_role_policy = data.aws_iam_policy_document.assume_from_service_account[0].json
  tags               = local.tags
}

resource "aws_iam_role_policy" "artifacts" {
  count = local.use_irsa ? 1 : 0

  name   = "artifacts"
  role   = aws_iam_role.artifacts[0].id
  policy = data.aws_iam_policy_document.artifacts_access.json
}

resource "aws_iam_user" "artifacts" {
  count = local.use_irsa ? 0 : 1

  name = "${var.name}-artifacts"
  tags = local.tags
}

resource "aws_iam_user_policy" "artifacts" {
  count = local.use_irsa ? 0 : 1

  name   = "artifacts"
  user   = aws_iam_user.artifacts[0].name
  policy = data.aws_iam_policy_document.artifacts_access.json
}

resource "aws_iam_access_key" "artifacts" {
  count = local.use_irsa ? 0 : 1

  user = aws_iam_user.artifacts[0].name
}
