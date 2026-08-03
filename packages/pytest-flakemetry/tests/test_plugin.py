"""End-to-end tests: run pytest inside pytest and inspect the batch it emits."""

from __future__ import annotations

import json

import pytest

pytest_plugins = ["pytester"]


def read_batch(pytester: pytest.Pytester) -> dict:
    with open(pytester.path / "out.json", encoding="utf-8") as handle:
        return json.load(handle)


def run(pytester: pytest.Pytester, *args: str):
    return pytester.runpytest_subprocess("--flakemetry-output", "out.json", *args)


def test_reports_pass_fail_and_skip(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        test_sample="""
        import pytest

        def test_ok():
            assert True

        def test_bad():
            assert 1 == 2, "boom"

        @pytest.mark.skip(reason="not yet")
        def test_later():
            pass
        """
    )
    result = run(pytester)
    result.assert_outcomes(passed=1, failed=1, skipped=1)

    batch = read_batch(pytester)
    assert batch["run"]["status"] == "failed"

    by_title = {execution["title"]: execution for execution in batch["executions"]}
    assert by_title["test_ok"]["status"] == "pass"
    assert by_title["test_bad"]["status"] == "fail"
    assert by_title["test_later"]["status"] == "skip"
    assert by_title["test_bad"]["error"]["message"]
    assert by_title["test_ok"]["filePath"] == "test_sample.py"


def test_parameterized_variants_carry_their_params(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        test_params="""
        import pytest

        @pytest.mark.parametrize("browser", ["chrome", "firefox"])
        def test_login(browser):
            assert browser
        """
    )
    run(pytester).assert_outcomes(passed=2)

    batch = read_batch(pytester)
    assert len(batch["executions"]) == 2
    # The parameter id is stripped from the title and travels as params, so the
    # server can bucket the variants under one base test.
    assert {execution["title"] for execution in batch["executions"]} == {"test_login"}
    assert sorted(execution["params"]["browser"] for execution in batch["executions"]) == [
        "chrome",
        "firefox",
    ]


def test_a_test_that_passes_on_rerun_is_flaky(pytester: pytest.Pytester) -> None:
    pytest.importorskip("pytest_rerunfailures")
    pytester.makepyfile(
        test_flaky="""
        counter = {"runs": 0}

        def test_eventually_passes():
            counter["runs"] += 1
            assert counter["runs"] > 1
        """
    )
    run(pytester, "--reruns", "2")

    batch = read_batch(pytester)
    execution = batch["executions"][0]
    assert execution["status"] == "flaky"
    assert execution["attempt"] >= 1


def test_class_based_tests_use_the_class_as_the_suite(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        test_suite="""
        class TestCheckout:
            def test_pays(self):
                assert True
        """
    )
    run(pytester).assert_outcomes(passed=1)

    execution = read_batch(pytester)["executions"][0]
    assert execution["suite"] == "TestCheckout"
    assert execution["title"] == "test_pays"


def test_writes_nothing_when_no_tests_ran(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(test_empty="")
    run(pytester)
    assert not (pytester.path / "out.json").exists()


def test_a_broken_endpoint_does_not_fail_the_run(pytester: pytest.Pytester) -> None:
    pytester.makepyfile(
        test_ok="""
        def test_ok():
            assert True
        """
    )
    result = run(
        pytester,
        "--flakemetry-endpoint",
        "http://127.0.0.1:9",
        "--flakemetry-token",
        "fmk_nope",
    )
    # Delivery fails against a dead port, but the suite still reports success.
    result.assert_outcomes(passed=1)
    assert result.ret == 0
