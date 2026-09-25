"""Docker/Podman container monitor, split by concern: the plugin, and the registry lookup behind its image update detection."""

from vigil.plugins.containers.plugin import Containers

__all__ = ['Containers']
