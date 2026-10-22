"""Agent key loading — the agent's private key file, and the server's public keys."""

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.asymmetric.rsa import generate_private_key


def _write_private_key(path, key):
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.OpenSSH,
                                       serialization.NoEncryption()))


def _public_line(key):
    return key.public_key().public_bytes(serialization.Encoding.OpenSSH,
                                         serialization.PublicFormat.OpenSSH).decode() + " node-a"


class TestAgentConfig:
    def test_a_key_file_is_loaded(self, tmp_path, monkeypatch):
        from x_monitor_agent.config import AgentConfig

        key = Ed25519PrivateKey.generate()
        key_file = tmp_path / "key"
        _write_private_key(key_file, key)
        config_file = tmp_path / "agent.yaml"
        config_file.write_text(f"url: ws://x_monitor/api/agent/ws\nid: node-a\nkey_file: {key_file}\n")
        for var in ('XMONITOR_AGENT_URL', 'XMONITOR_AGENT_ID', 'XMONITOR_AGENT_KEY_FILE'):
            monkeypatch.delenv(var, raising=False)

        loaded = AgentConfig.load(str(config_file)).key
        assert loaded.public_key().public_bytes_raw() == key.public_key().public_bytes_raw()

    def test_an_unreadable_key_file_fails_loudly(self, tmp_path, monkeypatch):
        """Falling through to no key would surface as a confusing auth
        rejection at the server instead of a deployment error here."""
        from x_monitor_agent.config import AgentConfig

        config_file = tmp_path / "agent.yaml"
        config_file.write_text(
            f"url: ws://x_monitor/api/agent/ws\nid: node-a\nkey_file: {tmp_path}/missing\n"
        )
        monkeypatch.delenv('XMONITOR_AGENT_KEY_FILE', raising=False)

        with pytest.raises(SystemExit, match="key_file"):
            AgentConfig.load(str(config_file))

    def test_a_non_ed25519_key_fails_loudly(self, tmp_path, monkeypatch):
        from x_monitor_agent.config import AgentConfig

        key_file = tmp_path / "key"
        _write_private_key(key_file, generate_private_key(65537, 2048))
        config_file = tmp_path / "agent.yaml"
        config_file.write_text(f"url: ws://x_monitor/api/agent/ws\nid: node-a\nkey_file: {key_file}\n")
        monkeypatch.delenv('XMONITOR_AGENT_KEY_FILE', raising=False)

        with pytest.raises(SystemExit, match="ed25519"):
            AgentConfig.load(str(config_file))

    def test_the_environment_names_the_key_file(self, tmp_path, monkeypatch):
        from x_monitor_agent.config import AgentConfig

        key_file = tmp_path / "key"
        _write_private_key(key_file, Ed25519PrivateKey.generate())
        config_file = tmp_path / "agent.yaml"
        config_file.write_text("url: ws://x_monitor/api/agent/ws\nid: node-a\n")
        monkeypatch.setenv('XMONITOR_AGENT_KEY_FILE', str(key_file))

        assert AgentConfig.load(str(config_file)).key is not None


class TestServerSidePublicKey:
    """`agents:` entries carry only a public key, so the server holds no agent secret."""

    def test_a_public_key_is_parsed(self):
        from x_monitor.core.connectors.agent_connector import AgentRegistry

        registry = AgentRegistry()
        line = _public_line(Ed25519PrivateKey.generate())
        registry.configure([{'id': 'node-a', 'public_key': line}])
        assert registry.public_key_for('node-a') is not None

    def test_a_malformed_public_key_leaves_the_agent_unauthenticatable(self):
        from x_monitor.core.connectors.agent_connector import AgentRegistry

        registry = AgentRegistry()
        registry.configure([{'id': 'node-a', 'public_key': 'ssh-ed25519 not-base64'}])
        assert registry.public_key_for('node-a') is None

    def test_a_non_ed25519_public_key_is_refused(self):
        from x_monitor.core.connectors.agent_connector import AgentRegistry

        registry = AgentRegistry()
        line = _public_line(generate_private_key(65537, 2048))
        registry.configure([{'id': 'node-a', 'public_key': line}])
        assert registry.public_key_for('node-a') is None


class TestSignature:
    def test_a_signature_verifies_against_its_own_nonce(self):
        from x_monitor_agent import keys

        key = Ed25519PrivateKey.generate()
        nonce = keys.new_nonce()
        assert keys.verify(key.public_key(), 'node-a', nonce, keys.sign(key, 'node-a', nonce))

    def test_a_signature_over_another_nonce_is_rejected(self):
        from x_monitor_agent import keys

        key = Ed25519PrivateKey.generate()
        signature = keys.sign(key, 'node-a', keys.new_nonce())
        assert not keys.verify(key.public_key(), 'node-a', keys.new_nonce(), signature)

    def test_a_signature_for_another_agent_id_is_rejected(self):
        from x_monitor_agent import keys

        key = Ed25519PrivateKey.generate()
        nonce = keys.new_nonce()
        assert not keys.verify(key.public_key(), 'node-b', nonce, keys.sign(key, 'node-a', nonce))

    def test_a_garbage_signature_is_rejected(self):
        from x_monitor_agent import keys

        key = Ed25519PrivateKey.generate()
        assert not keys.verify(key.public_key(), 'node-a', keys.new_nonce(), 'not base64!')
        assert not keys.verify(None, 'node-a', keys.new_nonce(), 'AAAA')
