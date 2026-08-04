# Releasing pytest-flakemetry

The JavaScript packages publish through changesets. Python has no equivalent here, so
this package publishes from `.github/workflows/python-release.yml` on an explicit tag.

Authentication is [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/):
GitHub mints a short-lived credential from the workflow's OIDC token, so there is no API
token stored in this repository and nothing to rotate or leak.

## One-time setup

This has to happen on PyPI, under the account that will own the project. It cannot be
done from the repository.

1. Create the two GitHub environments the workflow references — repository
   **Settings → Environments** — named `pypi` and `testpypi`. PyPI's trusted publisher
   binds to the environment name, so it has to match.

2. On PyPI, go to **Your projects → Publishing** (for a name that does not exist yet, use
   **[Add a pending publisher](https://pypi.org/manage/account/publishing/)**) and fill in:

   | Field | Value |
   | --- | --- |
   | PyPI project name | `pytest-flakemetry` |
   | Owner | `AKogut` |
   | Repository name | `flakemetry` |
   | Workflow name | `python-release.yml` |
   | Environment name | `pypi` |

3. Repeat on [TestPyPI](https://test.pypi.org/manage/account/publishing/) with the
   environment name `testpypi` if you want the rehearsal below.

The publisher is *pending* until the first upload, which is what lets you claim a name
that has never been published.

## Releasing

Rehearse against TestPyPI first — **Actions → python release → Run workflow**, repository
`testpypi`. A release published to PyPI cannot be replaced, only yanked, and a version
number is never reusable.

Then:

```bash
# bump `version` in pyproject.toml, commit it, and tag it to match
git tag pytest-flakemetry-v0.1.0
git push origin pytest-flakemetry-v0.1.0
```

The workflow refuses to publish when the tag and `pyproject.toml` disagree, runs the test
suite on the tagged tree, builds, and checks the artifacts with `twine` before uploading.

## Verifying

```bash
pip install pytest-flakemetry
python -c "import pytest_flakemetry; print(pytest_flakemetry.__file__)"
```

`pytest --flakemetry-output run.json` should then write a run file from any pytest suite.
