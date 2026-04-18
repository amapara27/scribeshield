# XGBoost Training Guide (Telephony Audio)

This guide trains XGBoost **using telephony audio only** from your generated dataset.

## 1) Use the correct source files

Primary input files:

- `backend/audio_gen/output/run_5x_v2/clips_rich_noise_rebalanced.jsonl` (canonical manifest)
- `backend/audio_gen/output/run_5x_v2/clips_rich_noise_rebalanced.csv` (tabular export for ML workflows)

Important: always use `audio_telephony_path` from each JSONL row, not `audio_clean_path`.
For this dataset:

- noisy scenarios (`noisy_environment`, `medical_conversation`) use `telephony_rich_noisy/...`
- non-noisy scenarios (`clean_speech`, `accented_speech`) use `telephony/...`

Do **not** hardcode one directory; read each row’s `audio_telephony_path`.

This rebalanced manifest uses family-aware split assignment so each split contains both classes:

- train: 56 non-noisy / 84 noisy
- val: 12 non-noisy / 18 noisy
- test: 12 non-noisy / 18 noisy

## 2) Recommended training targets

Train separate models (one target per model):

- `scenario_group` (multiclass): `baseline | noisy | accented | medical`
- `contains_numeric_confusion` (binary)
- `medical_domain` (binary)
- `numeric_confusion_type` (multiclass: `digit_vs_digit | dose_confusion | duration_confusion | none`)

## 3) Feature recipe (telephony-first)

For each `audio_telephony_path`, extract acoustic features and combine with metadata features.

Suggested acoustic features:

- MFCC mean + std (13 coefficients)
- RMS energy mean/std
- zero-crossing rate mean/std
- spectral centroid mean/std
- spectral rolloff mean/std
- duration (from file)

Suggested metadata features:

- one-hot: `voice_type`, `speech_style`, `accent`, `noise_level`, `scenario`, `split`
- binary flags: `has_interruptions`, `contains_ambiguity`, `contains_medical_terms`

Do not feed text directly into XGBoost unless you intentionally add text embeddings as separate features.

## 4) Split strategy

Use provided `split` column as the default:

- train: `split == train`
- val: `split == val`
- test: `split == test`

Leakage guard for cross-validation:

- if available, group by `script_family_id`
- otherwise group by `base_script_id`

Never place clips from the same script family in both train and validation folds.

## 5) Environment

Activate your conda env and install ML packages:

```bash
source $(conda info --base)/etc/profile.d/conda.sh
conda activate village-hacks
pip install xgboost scikit-learn pandas numpy librosa soundfile
```

## 6) Minimal training script (telephony-only)

Save as `backend/audio_gen/train_xgboost_telephony.py` and run it.

```python
from __future__ import annotations

import json
from pathlib import Path

import librosa
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.metrics import classification_report
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder
from xgboost import XGBClassifier

RUN_DIR = Path("backend/audio_gen/output/run_5x_v2")
CLIPS_PATH = RUN_DIR / "clips_rich_noise_rebalanced.jsonl"
TARGET = "scenario_group"  # change to contains_numeric_confusion / medical_domain / numeric_confusion_type


def load_rows(path: Path) -> pd.DataFrame:
    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    return pd.DataFrame(rows)


def audio_features(wav_path: Path) -> dict[str, float]:
    y, sr = librosa.load(wav_path, sr=8000, mono=True)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    rms = librosa.feature.rms(y=y)
    zcr = librosa.feature.zero_crossing_rate(y)
    centroid = librosa.feature.spectral_centroid(y=y, sr=sr)
    rolloff = librosa.feature.spectral_rolloff(y=y, sr=sr)

    out = {"duration_sec_file": len(y) / sr}
    for i in range(13):
        out[f"mfcc_{i+1}_mean"] = float(mfcc[i].mean())
        out[f"mfcc_{i+1}_std"] = float(mfcc[i].std())

    out.update(
        {
            "rms_mean": float(rms.mean()),
            "rms_std": float(rms.std()),
            "zcr_mean": float(zcr.mean()),
            "zcr_std": float(zcr.std()),
            "centroid_mean": float(centroid.mean()),
            "centroid_std": float(centroid.std()),
            "rolloff_mean": float(rolloff.mean()),
            "rolloff_std": float(rolloff.std()),
        }
    )
    return out


def build_feature_frame(df: pd.DataFrame, run_dir: Path) -> pd.DataFrame:
    feats = []
    for _, row in df.iterrows():
        wav_path = run_dir / row["audio_telephony_path"]
        a = audio_features(wav_path)
        a.update(
            {
                "voice_type": row.get("voice_type", "unknown"),
                "speech_style": row.get("speech_style", "unknown"),
                "accent": row.get("accent", "unknown"),
                "noise_level": row.get("noise_level", "unknown"),
                "scenario": row.get("scenario", "unknown"),
                "has_interruptions": int(bool(row.get("has_interruptions", False))),
                "contains_ambiguity": int(bool(row.get("contains_ambiguity", False))),
                "contains_medical_terms": int(bool(row.get("contains_medical_terms", False))),
                "split": row.get("split", "train"),
            }
        )
        feats.append(a)
    return pd.DataFrame(feats)


def main() -> None:
    df = load_rows(CLIPS_PATH)
    X = build_feature_frame(df, RUN_DIR)
    y = df[TARGET].astype(str)

    train_mask = X["split"] == "train"
    val_mask = X["split"] == "val"
    test_mask = X["split"] == "test"

    cat_cols = ["voice_type", "speech_style", "accent", "noise_level", "scenario"]
    drop_cols = ["split"]
    num_cols = [c for c in X.columns if c not in set(cat_cols + drop_cols)]

    pre = ColumnTransformer(
        transformers=[("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols)],
        remainder="passthrough",
    )

    clf = XGBClassifier(
        objective="multi:softprob" if y.nunique() > 2 else "binary:logistic",
        eval_metric="mlogloss" if y.nunique() > 2 else "logloss",
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        tree_method="hist",
        random_state=42,
    )

    model = Pipeline([("pre", pre), ("clf", clf)])

    model.fit(X.loc[train_mask, cat_cols + num_cols], y.loc[train_mask])

    if val_mask.any():
        pred_val = model.predict(X.loc[val_mask, cat_cols + num_cols])
        print("\\nValidation report")
        print(classification_report(y.loc[val_mask], pred_val))

    if test_mask.any():
        pred_test = model.predict(X.loc[test_mask, cat_cols + num_cols])
        print("\\nTest report")
        print(classification_report(y.loc[test_mask], pred_test))


if __name__ == "__main__":
    main()
```

Run:

```bash
python backend/audio_gen/train_xgboost_telephony.py
```

## 7) Practical notes

- Start with `TARGET=scenario_group` for the most stable baseline.
- If classes are imbalanced, add class weights (`sample_weight`) during fit.
- Keep `audio_clean_path` out of training to match real telephony conditions.
- Training dataset readiness report is in:
  - `backend/audio_gen/output/run_5x_v2/xgboost_dataset_report_rebalanced.json`
- Save final model with `joblib` or `xgboost` built-in model save after evaluation.
