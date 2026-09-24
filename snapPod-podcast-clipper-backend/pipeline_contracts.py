from typing import Any


def validate_moments(
    moments: Any,
    transcript: list[dict[str, Any]],
    requested_count: int,
) -> list[dict[str, float]]:
    """Return the strongest valid, non-overlapping moments in model order."""
    if not isinstance(moments, list) or requested_count < 1:
        return []

    source_end = max(
        (
            float(segment.get("end", 0))
            for segment in transcript
            if isinstance(segment, dict)
        ),
        default=0,
    )
    selected: list[dict[str, float]] = []

    for moment in moments:
        if not isinstance(moment, dict):
            continue
        try:
            start = float(moment["start"])
            end = float(moment["end"])
        except (KeyError, TypeError, ValueError):
            continue

        duration = end - start
        if start < 0 or end > source_end + 1 or duration < 30 or duration > 60:
            continue

        overlaps = any(
            max(0, min(end, item["end"]) - max(start, item["start"]))
            / min(duration, item["end"] - item["start"])
            > 0.3
            for item in selected
        )
        if overlaps:
            continue

        selected.append({"start": start, "end": end})
        if len(selected) >= requested_count:
            break

    return selected
