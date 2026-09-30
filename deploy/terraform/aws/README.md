# Flakemetry on AWS: managed dependencies

This module provisions what the [Helm chart](../../helm/flakemetry) expects to find: a
PostgreSQL 16 database and an artifact bucket. It then writes the chart values that connect
the two. It does not create a VPC or a Kubernetes cluster; it goes into the ones you have.

## What it creates

| | |
| --- | --- |
| **RDS for PostgreSQL 16** | Private, encrypted, gp3 with storage autoscaling, 7 days of automated backups, deletion protection and a final snapshot. Its security group admits only the security groups or CIDR blocks you name, on 5432 |
| **S3 bucket** | Every public access block on, bucket-owner-enforced ownership, SSE-S3 or your KMS key, a policy refusing plain HTTP, and incomplete uploads cleaned up after 7 days. Artifacts are pruned by the worker according to each project's retention policy, so the bucket expires nothing unless you set `artifact_expiration_days` |
| **CORS** | `GET` and `HEAD` from the dashboard origins in `web_origins`, so the browser can read artifacts. CI uploads through presigned URLs and needs no CORS |
| **S3 access** | With `eks_oidc_provider_arn`, an IAM role that only the release's service account can assume. Without it, an IAM user and an access key. Both are limited to this bucket |

## Use it

```hcl
module "flakemetry" {
  source = "github.com/AKogut/flakemetry//deploy/terraform/aws?ref=main"

  vpc_id                     = module.vpc.vpc_id
  database_subnet_ids        = module.vpc.private_subnets
  allowed_security_group_ids = [module.eks.node_security_group_id]
  web_origins                = ["https://flakemetry.example.com"]

  eks_oidc_provider_arn = module.eks.oidc_provider_arn
}

output "helm_values" {
  value     = module.flakemetry.helm_values
  sensitive = true
}
```

[`examples/eks`](examples/eks) is a complete root configuration. Then:

```bash
terraform apply
terraform output -raw helm_values > terraform-values.yaml

helm upgrade --install flakemetry deploy/helm/flakemetry -n flakemetry --create-namespace \
  -f terraform-values.yaml -f my-values.yaml
```

`terraform-values.yaml` sets `database.url`, `database.caBundle`, the `storage` block, and
the service account annotation or the access key. `my-values.yaml` holds the rest: `auth`,
hostnames, and ingress. Pass it second so it can override anything. The generated file holds
the database password; it is in `.gitignore`, and it belongs in your secret manager, not in
a repository.

`kubernetes_namespace` and `kubernetes_service_account` must match the release: the chart
names its service account after the release, `flakemetry` for a release called
`flakemetry`.

## TLS to the database

RDS requires TLS, and `database_url` asks for `sslmode=verify-full`. Node does not trust
the Amazon RDS certificate authority by default, so the module fetches
[its bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) and passes
it to the chart as `database.caBundle`. The chart mounts it into every pod that connects
and points `NODE_EXTRA_CA_CERTS` at it. Without the bundle, `verify-full` fails with
`unable to verify the first certificate`, which is the failure you want if something
between the pods and the database presents another certificate.

## State

The Terraform state holds the database password and, without IRSA, the access key. Keep
it in an encrypted remote backend with restricted access, as for any state holding secrets.

## Tests

`terraform test` runs [`tests/module.tftest.hcl`](tests/module.tftest.hcl) against mocked
providers, with no AWS account needed. It asserts:

- the database is private, encrypted, backed up and protected from deletion;
- the bucket is private, encrypted and refuses plain HTTP;
- CORS is read-only;
- keys are used, or IRSA, never both;
- every key written to `helm_values` is one `deploy/helm/flakemetry/values.yaml` has.

It also asserts that a database no client can reach, `0.0.0.0/0`, and an untested engine
version are refused. CI also runs `terraform validate` on the example and a Trivy scan.
The one accepted finding, bucket versioning, is explained in
[`../.trivyignore.yaml`](../.trivyignore.yaml).
