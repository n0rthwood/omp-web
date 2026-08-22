# tools/test_xor_secrets.py
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "xor-secrets.py"


def run(*args):
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        check=False,
    )


class XorSecretsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def test_seal_then_get_roundtrips_a_value(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sk-test-123\nXAI_API_KEY=xai-test-456\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"

        sealed = run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))
        self.assertEqual(sealed.returncode, 0, sealed.stderr)
        self.assertNotIn(b"sk-test-123", cipher.read_bytes())

        got = run("get", "--cipher", str(cipher), "--key", str(key), "--var", "DEEPSEEK_API_KEY")
        self.assertEqual(got.returncode, 0, got.stderr)
        self.assertEqual(got.stdout.strip(), "sk-test-123")

    def test_merge_keeps_existing_value_and_appends_new_keys(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sealed-value\nZHIPU_API_KEY=sealed-zhipu\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"
        run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))

        target = self.dir / ".env"
        target.write_text("DEEPSEEK_API_KEY=already-here\n")

        merged = run("merge", "--cipher", str(cipher), "--key", str(key), "--target", str(target))
        self.assertEqual(merged.returncode, 0, merged.stderr)

        text = target.read_text()
        self.assertIn("DEEPSEEK_API_KEY=already-here", text)
        self.assertNotIn("sealed-value", text)
        self.assertIn("ZHIPU_API_KEY=sealed-zhipu", text)

    def test_merge_skip_var_excludes_a_key(self):
        plain = self.dir / "secrets.env.plain"
        plain.write_text("DEEPSEEK_API_KEY=sealed-value\nOMP_WEB_PASSWORD=default-pw\n")
        cipher = self.dir / "secrets.env.xorb64"
        key = self.dir / "xor.key"
        run("seal", "--plain", str(plain), "--out-cipher", str(cipher), "--out-key", str(key))

        target = self.dir / ".env"
        merged = run(
            "merge", "--cipher", str(cipher), "--key", str(key),
            "--target", str(target), "--skip-var", "OMP_WEB_PASSWORD",
        )
        self.assertEqual(merged.returncode, 0, merged.stderr)

        text = target.read_text()
        self.assertIn("DEEPSEEK_API_KEY=sealed-value", text)
        self.assertNotIn("OMP_WEB_PASSWORD", text)


if __name__ == "__main__":
    unittest.main()
