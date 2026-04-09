# OpenClaw vs NemoClaw Learning Notes

## OpenClaw

OpenClaw is the framework core.

Key characteristics:
- Gateway-centered architecture
- Session and agent runtime ownership on the server side
- Plugin-based channels, providers, tools, and runtime extensions
- Existing support for sandbox backends, including OpenShell

What to learn from it:
- Architecture patterns
- Session and agent boundaries
- Channel and plugin abstractions
- Tool and execution runtime structure

## NemoClaw

NemoClaw is not a replacement framework.

It is an NVIDIA reference stack layered on top of OpenClaw, focused on:
- OpenShell-based sandboxing
- routed inference through `inference.local`
- host-owned credentials
- onboarding, migration, and DGX Spark setup

What to learn from it:
- NVIDIA platform framing
- local-first security posture
- deployment and operator experience
- Spark-specific setup and messaging

## VinkoClaw Direction

VinkoClaw should not clone either project.

It should:
- learn the platform model from OpenClaw
- learn the NVIDIA/Spark/operator framing from NemoClaw
- build a product layer for OPC: an AI team control system for one-person companies
