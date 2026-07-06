#!/usr/bin/env python3
"""Transcreve um arquivo de áudio localmente com faster-whisper.

Uso:
    python transcribe.py <caminho_do_audio> [tamanho_do_modelo]

Imprime o texto transcrito (puro) em stdout. Mensagens de log/erro vão para stderr.
"""
import sys


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Uso: transcribe.py <arquivo_audio> [modelo]\n")
        sys.exit(2)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.stderr.write(
            "faster-whisper nao instalado. Rode: "
            "pip install faster-whisper --break-system-packages\n"
        )
        sys.exit(3)

    try:
        # int8 na CPU: leve e sem GPU necessaria.
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(audio_path, language="pt")
        texto = "".join(segment.text for segment in segments).strip()
        sys.stdout.write(texto)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"Erro na transcricao: {exc}\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
