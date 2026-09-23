# Image Arranger

画像をInstagram / X(Twitter)用のサイズに整形し、余白に文字を入れられるWebアプリ。

## 機能

- 貼り付け（⌘V / Ctrl+V）・ドラッグ＆ドロップ・ファイル選択で画像を読み込み
- Instagram（4:5 / 1:1 / 9:16 / 1.91:1）、X（16:9 / 4:5 / 1:1）のサイズに余白付きで整形
- 上下の余白に文字入れ（フォント・サイズ・色・太さ・揃え）
- ぼかしペン（ぼかし / モザイク、消しゴム、元に戻す）
- 文字などの設定はCookieに自動保存
- JPEG / PNGでダウンロード、クリップボードにコピー、共有

## 使い方

公開版: https://syobonpastel.github.io/image_arranger/

ローカルで動かす場合（ビルド不要の静的サイト）:

```bash
python3 -m http.server 8000
```

http://localhost:8000 を開く。（`file://` で直接開くとブラウザによってはCookieが保存されないため、ローカルサーバー経由を推奨）
