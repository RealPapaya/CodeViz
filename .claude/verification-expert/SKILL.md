---
name: verification-expert
description: Specialized in verifying functional development results without making any modifications to the project code. Trigger this skill whenever the user asks to "verify functionality," "test," "check if requirements are met," or performs a "final review." It emphasizes read-only observation and systematic testing to ensure functionality is intact and no regression occurs before submission or delivery.
---

# Skill: Verification Expert

This skill is dedicated to verifying project functionality. Its core principle is: **Observe and test only; never modify code.**

## Use Cases

- Post-development verification.
- Confirmation testing after bug fixes.
- Checking if specific features meet expectations as per requirements.
- Final review before project delivery.

## Core Principles

1.  **NO CODE MUTATION**: Strictly prohibited from invoking `replace_file_content`, `multi_replace_file_content`, or any tool that modifies project source code while this skill is active.
2.  **SYSTEMATIC TESTING**: Follow a complete verification workflow instead of random trials.
3.  **READ-ONLY ANALYSIS**: Use `view_file`, `grep_search`, and `list_dir` to understand implementation details without touching them.

## Verification Workflow

### 1. Compliance Check
- Review original requirements, Task Lists, or instructions.
- Confirm that currently "completed" features map to every requirement.

### 2. Environment & State Audit
- Verify that relevant files exist and are in the correct paths.
- Use `run_command` (read-only mode) to check service status, database contents, or configurations.

### 3. Active Testing
- **Automated Testing**: Run existing Unit Tests or Integration Tests.
  ```bash
  # Example
  pytest test_core.py
  npm test
  ```
- **Manual Test Cases**: If UI is involved, use the `browser` tool for manual interaction.
- **Boundary Testing**: Test extreme inputs or abnormal flows to ensure robustness.

### 4. Side-effect Observation
- Observe `terminal` output for logs.
- Monitor the filesystem for any unexpected changes.

### 5. Reporting & Summary
- Generate a structured verification report:
  - [x] **Requirement**: [Status] (Pass/Fail)
  - **Evidence**: (Screenshots/Log snippets/Command output)
  - **Conclusion**: Ready for delivery/merging or not.

## Recommended Toolbox

- **Browser**: [Visual verification, UI interaction]
- **Terminal**: [Executing scripts, checking logs]
- **Read-only tools**: [`view_file`, `find_by_name`, `ls`]

---

> [!IMPORTANT]
> If a bug is discovered during verification, **deactivate this skill and return to Execution Mode**. The Verifier's responsibility is to "identify issues," not to "fix issues."
