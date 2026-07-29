package org.json;

import java.util.ArrayList;
import java.util.List;

public final class JSONArray {
    private final List<Object> values;

    public JSONArray() {
        values = new ArrayList<Object>();
    }

    @SuppressWarnings("unchecked")
    public JSONArray(String source) {
        Object parsed = new JSONParser(source).parse();
        if (!(parsed instanceof List)) {
            throw new IllegalArgumentException("JSON value is not an array");
        }
        values = (List<Object>) parsed;
    }

    JSONArray(List<Object> source) {
        values = source;
    }

    public JSONArray put(Object value) {
        values.add(value == null ? JSONObject.NULL : value);
        return this;
    }

    public int length() {
        return values.size();
    }

    public Object get(int index) {
        return JSONObject.wrap(values.get(index));
    }

    public JSONObject getJSONObject(int index) {
        JSONObject value = optJSONObject(index);
        if (value == null) {
            throw new IllegalArgumentException("invalid array object");
        }
        return value;
    }

    public JSONObject optJSONObject(int index) {
        if (index < 0 || index >= values.size()) return null;
        Object value = JSONObject.wrap(values.get(index));
        return value instanceof JSONObject ? (JSONObject) value : null;
    }

    public String getString(int index) {
        Object value = get(index);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException("invalid array string");
        }
        return (String) value;
    }

    public String optString(int index, String fallback) {
        if (index < 0 || index >= values.size()) return fallback;
        Object value = JSONObject.wrap(values.get(index));
        return value instanceof String ? (String) value : fallback;
    }

    @Override
    public String toString() {
        StringBuilder result = new StringBuilder("[");
        for (int index = 0; index < values.size(); index += 1) {
            if (index > 0) result.append(',');
            JSONObject.append(result, values.get(index));
        }
        return result.append(']').toString();
    }
}
