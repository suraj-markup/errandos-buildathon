package org.json;

import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;

public final class JSONObject {
    public static final Object NULL = new Object() {
        @Override
        public boolean equals(Object value) {
            return value == this || value == null;
        }

        @Override
        public String toString() {
            return "null";
        }
    };

    private final Map<String, Object> values;

    public JSONObject() {
        values = new LinkedHashMap<String, Object>();
    }

    @SuppressWarnings("unchecked")
    public JSONObject(String source) {
        Object parsed = new JSONParser(source).parse();
        if (!(parsed instanceof Map)) {
            throw new IllegalArgumentException("JSON value is not an object");
        }
        values = (Map<String, Object>) parsed;
    }

    JSONObject(Map<String, Object> source) {
        values = source;
    }

    public JSONObject put(String name, Object value) {
        values.put(name, value == null ? NULL : value);
        return this;
    }

    public boolean has(String name) {
        return values.containsKey(name);
    }

    public Iterator<String> keys() {
        return values.keySet().iterator();
    }

    public boolean isNull(String name) {
        return !values.containsKey(name) || values.get(name) == NULL;
    }

    public Object get(String name) {
        if (!values.containsKey(name)) {
            throw new IllegalArgumentException("missing " + name);
        }
        return wrap(values.get(name));
    }

    public Object opt(String name) {
        return wrap(values.get(name));
    }

    public String getString(String name) {
        Object value = get(name);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return (String) value;
    }

    public String optString(String name) {
        return optString(name, "");
    }

    public String optString(String name, String fallback) {
        Object value = opt(name);
        return value instanceof String ? (String) value : fallback;
    }

    public int getInt(String name) {
        Object value = get(name);
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return ((Number) value).intValue();
    }

    public int optInt(String name, int fallback) {
        Object value = opt(name);
        return value instanceof Number
            ? ((Number) value).intValue()
            : fallback;
    }

    public long getLong(String name) {
        Object value = get(name);
        if (!(value instanceof Number)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return ((Number) value).longValue();
    }

    public boolean getBoolean(String name) {
        Object value = get(name);
        if (!(value instanceof Boolean)) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return ((Boolean) value).booleanValue();
    }

    public boolean optBoolean(String name, boolean fallback) {
        Object value = opt(name);
        return value instanceof Boolean
            ? ((Boolean) value).booleanValue()
            : fallback;
    }

    public JSONObject getJSONObject(String name) {
        JSONObject value = optJSONObject(name);
        if (value == null) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return value;
    }

    public JSONObject optJSONObject(String name) {
        Object value = opt(name);
        return value instanceof JSONObject ? (JSONObject) value : null;
    }

    public JSONArray getJSONArray(String name) {
        JSONArray value = optJSONArray(name);
        if (value == null) {
            throw new IllegalArgumentException("invalid " + name);
        }
        return value;
    }

    public JSONArray optJSONArray(String name) {
        Object value = opt(name);
        return value instanceof JSONArray ? (JSONArray) value : null;
    }

    @Override
    public String toString() {
        StringBuilder result = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : values.entrySet()) {
            if (!first) result.append(',');
            first = false;
            result.append(quote(entry.getKey())).append(':');
            append(result, entry.getValue());
        }
        return result.append('}').toString();
    }

    @SuppressWarnings("unchecked")
    static Object wrap(Object value) {
        if (value instanceof Map) {
            return new JSONObject((Map<String, Object>) value);
        }
        if (value instanceof java.util.List) {
            return new JSONArray((java.util.List<Object>) value);
        }
        return value;
    }

    static void append(StringBuilder target, Object value) {
        Object wrapped = wrap(value);
        if (wrapped == null || wrapped == NULL) {
            target.append("null");
        } else if (wrapped instanceof String) {
            target.append(quote((String) wrapped));
        } else {
            target.append(wrapped.toString());
        }
    }

    static String quote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character == '"' || character == '\\') {
                result.append('\\').append(character);
            } else if (character == '\n') {
                result.append("\\n");
            } else if (character == '\r') {
                result.append("\\r");
            } else if (character == '\t') {
                result.append("\\t");
            } else if (character < 0x20) {
                result.append(String.format("\\u%04x", (int) character));
            } else {
                result.append(character);
            }
        }
        return result.append('"').toString();
    }
}
