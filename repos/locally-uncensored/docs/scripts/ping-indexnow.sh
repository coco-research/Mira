#!/bin/bash
# Auto-sync sitemap with blog posts + ping IndexNow
# Run after publishing new blog posts

DOCS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SITEMAP="$DOCS_DIR/sitemap.xml"
DOMAIN="https://locallyuncensored.com"
KEY="64c8084e74dd0e16c6152f82363537ad"

# Find all blog HTML files
NEW_URLS=""
for f in "$DOCS_DIR"/blog/*.html; do
  fname=$(basename "$f")
  url="$DOMAIN/blog/$fname"
  if ! grep -q "$url" "$SITEMAP" 2>/dev/null; then
    # Add to sitemap before closing </urlset>
    DATE=$(date +%Y-%m-%d)
    ENTRY="  <url><loc>$url</loc><lastmod>$DATE</lastmod><changefreq>monthly</changefreq><priority>0.9</priority></url>"
    sed -i "s|</urlset>|$ENTRY\n</urlset>|" "$SITEMAP"
    NEW_URLS="$NEW_URLS\"$url\","
    echo "Added to sitemap: $fname"
  fi
done

# Also always include homepage
ALL_URLS=$(grep -oP '(?<=<loc>)[^<]+' "$SITEMAP" | while read u; do echo "\"$u\""; done | paste -sd,)

if [ -n "$NEW_URLS" ]; then
  # Ping IndexNow with new URLs
  curl -s -X POST "https://api.indexnow.org/IndexNow" \
    -H "Content-Type: application/json" \
    -d "{
      \"host\": \"locallyuncensored.com\",
      \"key\": \"$KEY\",
      \"keyLocation\": \"$DOMAIN/$KEY.txt\",
      \"urlList\": [$ALL_URLS]
    }" -w "\nIndexNow: HTTP %{http_code}\n"
  echo "Pinged IndexNow with all URLs"
else
  echo "No new blog posts found"
fi
