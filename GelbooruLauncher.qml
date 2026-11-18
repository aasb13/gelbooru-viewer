import QtQuick

Item {
    id: root

    property var pluginService: null
    property string trigger: ""

    signal itemsChanged()

    Component.onCompleted: itemsChanged()

    function getItems(query) {
        return [
            {
                name: "Gelbooru",
                icon: "material:image",
                comment: "Browse Gelbooru",
                action: "custom:openViewer",
                categories: ["Gelbooru"]
            }
        ]
    }

    function executeItem(item) {
        if (!item || !item.action)
            return
        if (item.action === "custom:openViewer")
            pluginService?.savePluginData("gelbooruDux", "viewerOpen", true)
    }
}
