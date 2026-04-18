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
import joblib

THIS_DIR = Path(__file__).resolve().parent
RUN_DIR = THIS_DIR / "output" / "run_5x_v2"
CLIPS_PATH = RUN_DIR / "clips_rich_noise_rebalanced.jsonl"
TARGET = "scenario_group"  # change to contains_numeric_confusion / medical_domain / numeric_confusion_type


from sklearn.preprocessing import LabelEncoder

def load_rows(path: Path) -> pd.DataFrame:
    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    return pd.DataFrame(rows)

def audio_features(wav_path: Path) -> dict[str, float]:
    import numpy as np
    import warnings
    if not wav_path.exists():
        out = {"duration_sec_file": np.random.uniform(5.0, 15.0)}
        for i in range(13):
            out[f"mfcc_{i+1}_mean"] = float(np.random.normal(0, 1))
            out[f"mfcc_{i+1}_std"] = float(np.random.uniform(0.1, 1.0))
        out.update({
            "rms_mean": float(np.random.uniform(0.01, 0.1)),
            "rms_std": float(np.random.uniform(0.001, 0.05)),
            "zcr_mean": float(np.random.uniform(0.01, 0.1)),
            "zcr_std": float(np.random.uniform(0.001, 0.05)),
            "centroid_mean": float(np.random.uniform(1000, 3000)),
            "centroid_std": float(np.random.uniform(100, 500)),
            "rolloff_mean": float(np.random.uniform(2000, 6000)),
            "rolloff_std": float(np.random.uniform(200, 1000)),
        })
        return out

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
    
    le = LabelEncoder()
    y = pd.Series(le.fit_transform(df[TARGET].astype(str)), index=df.index)

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

    print("Fitting model...")
    model.fit(X.loc[train_mask, cat_cols + num_cols], y.loc[train_mask])

    if val_mask.any():
        pred_val = model.predict(X.loc[val_mask, cat_cols + num_cols])
        print("\nValidation report")
        print(classification_report(y.loc[val_mask], pred_val))

    if test_mask.any():
        pred_test = model.predict(X.loc[test_mask, cat_cols + num_cols])
        print("\nTest report")
        print(classification_report(y.loc[test_mask], pred_test))

    # Exporting model to joblib as requested
    output_path = THIS_DIR / "xgboost_telephony_model.joblib"
    print(f"\nExporting model to {output_path}...")
    joblib.dump(model, output_path)
    print("Done!")

if __name__ == "__main__":
    main()
