# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["timesfm[torch]==3.0.1", "torch==2.10.0"]
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""Past-only forecast preparation for AutoResearch, separate from the benchmark."""

from timesfm_research import main


if __name__ == "__main__":
    main()
