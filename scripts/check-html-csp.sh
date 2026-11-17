#!/bin/sh
# Fail when an HTML page has what the privileged CSP blocks: inline <script> or <style>, style="..." or on*="..." attributes, or javascript: URLs.
set -e
page="$1"
bad=0
if grep -inE '<script' "$page" | grep -viE '<script[^>]*[[:space:]]src[[:space:]]*='; then
  echo "FAIL: $page has an inline <script>." >&2
  bad=1
fi
if grep -inE '<style|[[:space:]]style[[:space:]]*=|[[:space:]]on[a-z]+[[:space:]]*=|javascript:' "$page"; then
  echo "FAIL: $page has inline styles, event handler attributes, or javascript: URLs." >&2
  bad=1
fi
exit $bad
