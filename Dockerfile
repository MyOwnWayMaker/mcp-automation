FROM mcr.microsoft.com/playwright:v1.59.0-noble

# OCR + PDF rendering toolchain for extract_pdf_text's OCR fallback path.
# poppler-utils provides pdftoppm (renders PDF pages to PNG); tesseract-ocr
# + tesseract-ocr-eng provide the OCR engine and English language data.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# `npm ci` requires lock-file to match package.json exactly; fall back to
# `npm install` so deps added without a local lock-file refresh still build.
RUN npm ci || npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
