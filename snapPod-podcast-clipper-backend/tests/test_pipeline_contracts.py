import unittest

from pipeline_contracts import validate_moments


class ValidateMomentsTests(unittest.TestCase):
    def setUp(self):
        self.transcript = [{"start": 0, "end": 240, "word": "test"}]

    def test_keeps_rank_order_and_requested_limit(self):
        moments = [
            {"start": 0, "end": 45},
            {"start": 60, "end": 110},
            {"start": 130, "end": 180},
        ]

        self.assertEqual(validate_moments(moments, self.transcript, 2), moments[:2])

    def test_rejects_invalid_durations_bounds_and_shapes(self):
        moments = [
            {"start": 0, "end": 20},
            {"start": 0, "end": 61},
            {"start": -1, "end": 40},
            {"start": 220, "end": 260},
            {"start": "bad", "end": 45},
            {"end": 45},
            "not-a-moment",
            {"start": 30, "end": 70},
        ]

        self.assertEqual(
            validate_moments(moments, self.transcript, 5),
            [{"start": 30.0, "end": 70.0}],
        )

    def test_rejects_material_overlap_but_allows_small_overlap(self):
        moments = [
            {"start": 0, "end": 50},
            {"start": 30, "end": 75},
            {"start": 40, "end": 90},
        ]

        self.assertEqual(
            validate_moments(moments, self.transcript, 3),
            [{"start": 0.0, "end": 50.0}, {"start": 40.0, "end": 90.0}],
        )

    def test_handles_empty_or_non_list_model_output(self):
        self.assertEqual(validate_moments({}, self.transcript, 3), [])
        self.assertEqual(validate_moments([], self.transcript, 3), [])


if __name__ == "__main__":
    unittest.main()
