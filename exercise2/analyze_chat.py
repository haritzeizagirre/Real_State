#!/usr/bin/env python3
"""
analyze_chat.py — Analyze a VS Code Copilot chat.json transcript.

Outputs a JSON summary with duration and tool-call stats so you can compare
runs across models/agents.

Usage:
    python analyze_chat.py chat.json
    python analyze_chat.py chat.json --label "claude-sonnet-4.6 run 1"
    python analyze_chat.py chat.json --pretty
"""

import argparse
import json
import sys
from collections import Counter


def analyze(data: dict, label: str | None) -> dict:
    requests = data.get("requests", [])
    responder = data.get("responderUsername", "unknown")

    per_request = []
    total_elapsed_ms = 0
    total_tools = 0
    all_tool_counts: Counter = Counter()

    for req in requests:
        req_id = req.get("requestId", "unknown")
        model_id = req.get("modelId", "unknown")

        # --- Duration ---
        timings = (req.get("result") or {}).get("timings", {})
        elapsed_ms = timings.get("totalElapsed")  # ms
        first_progress_ms = timings.get("firstProgress")

        # --- Tool calls (from response items) ---
        tool_ids: list[str] = []
        for item in req.get("response", []):
            if item.get("kind") == "toolInvocationSerialized":
                tool_id = item.get("toolId") or item.get("toolCallId", "unknown")
                tool_ids.append(tool_id)

        tool_count = len(tool_ids)
        tool_breakdown = dict(Counter(tool_ids))

        # Accumulate totals
        if elapsed_ms is not None:
            total_elapsed_ms += elapsed_ms
        total_tools += tool_count
        all_tool_counts.update(tool_breakdown)

        per_request.append(
            {
                "request_id": req_id,
                "model_id": model_id,
                "duration_ms": elapsed_ms,
                "duration_s": round(elapsed_ms / 1000, 2) if elapsed_ms is not None else None,
                "first_progress_ms": first_progress_ms,
                "tool_call_count": tool_count,
                "tool_call_breakdown": tool_breakdown,
            }
        )

    result: dict = {
        "label": label,
        "responder": responder,
        "request_count": len(requests),
        "total_duration_ms": total_elapsed_ms,
        "total_duration_s": round(total_elapsed_ms / 1000, 2),
        "total_tool_call_count": total_tools,
        "total_tool_call_breakdown": dict(all_tool_counts),
    }

    # Inline the single-request fields at top level when there's only one request
    if len(per_request) == 1:
        r = per_request[0]
        result["model_id"] = r["model_id"]
        result["duration_ms"] = r["duration_ms"]
        result["duration_s"] = r["duration_s"]
        result["first_progress_ms"] = r["first_progress_ms"]
    else:
        result["requests"] = per_request

    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze a Copilot chat.json transcript.")
    parser.add_argument("file", help="Path to chat.json")
    parser.add_argument("--label", help="Optional label for this run (e.g. model name or experiment id)")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output (2-space indent)")
    args = parser.parse_args()

    try:
        with open(args.file, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"Error: file not found: {args.file}", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: invalid JSON: {exc}", file=sys.stderr)
        sys.exit(1)

    summary = analyze(data, args.label)
    indent = 2 if args.pretty else None
    print(json.dumps(summary, indent=indent, ensure_ascii=False))


if __name__ == "__main__":
    main()