import { call, DeepPartial, numberToCommaString, useAppContext } from "client";
import { useCallback, useMemo, useRef, useState } from "react";
import { NewCategoryGetResponse, Section } from "server";
import CategoryComponent from "./CategoryComponent";

interface Props {
  section: Section;
}

const SectionComponent = ({ section }: Props) => {
  const { section_id, name, capacity } = section;

  const { sections, setSections, categories, setCategories, selectedInterval } =
    useAppContext();

  const [nameInput, setNameInput] = useState(name);
  const [capacityInput, setCapacityInput] = useState(
    numberToCommaString(capacity[selectedInterval])
  );

  const onClickAdd = async () => {
    const queryString = "?" + new URLSearchParams({ parent: section_id }).toString();
    const newCategoryRequestUrl = "/api/new-category" + queryString;
    const { data } = await call.get<NewCategoryGetResponse>(newCategoryRequestUrl);

    setCategories((oldCategories) => {
      const newCategories = new Map(oldCategories);
      const category_id = data?.category_id;
      if (category_id) {
        newCategories.set(category_id, {
          category_id,
          section_id,
          name: "",
          capacity: { year: 0, month: 0, week: 0, day: 0 },
        });
      }

      return newCategories;
    });
  };

  const revertInputs = useCallback(() => {
    setNameInput(name);
    setCapacityInput(numberToCommaString(capacity[selectedInterval]));
  }, [name, setNameInput, capacity, setCapacityInput, selectedInterval]);

  const categoryComponents = useMemo(() => {
    return Array.from(categories.values())
      .filter((e) => e.section_id === section_id)
      .map((e) => {
        return <CategoryComponent key={e.category_id} category={e} />;
      });
  }, [categories, section_id]);

  type SetTimeout = typeof setTimeout;
  type Timeout = ReturnType<SetTimeout>;

  const timeout = useRef<Timeout>();

  const submit = useCallback(
    (updatedSection: DeepPartial<Section> = {}, delay = 500) => {
      clearTimeout(timeout.current);
      timeout.current = setTimeout(async () => {
        try {
          const { status } = await call.post("/api/section", {
            ...updatedSection,
            section_id,
          });
          if (status === "success") {
            setSections((oldSections) => {
              const newSections = new Map(oldSections);
              const oldSection = oldSections.get(section_id);
              const newSection = { ...oldSection, ...updatedSection };
              newSections.set(section_id, newSection as Section);
              return newSections;
            });
          } else throw new Error(`Failed to update section: ${section_id}`);
        } catch (error: any) {
          console.error(error);
          revertInputs();
        }
      }, delay);
    },
    [setSections, section_id, revertInputs]
  );

  const onClickRemove = useCallback(async () => {
    const queryString = "?" + new URLSearchParams({ id: section_id }).toString();
    const { status } = await call.delete("/api/section" + queryString);
    if (status === "success") {
      setSections((oldSections) => {
        const newSections = new Map(oldSections);
        newSections.delete(section_id);
        return newSections;
      });
    }
  }, [section_id, setSections]);

  const currentTotal = useMemo(() => {
    return Array.from(categories.values())
      .filter((e) => {
        if (!e.amount) return false;
        const parentSection = sections.get(e.section_id);
        if (!parentSection) return false;
        return parentSection === section;
      })
      .reduce((acc, e) => acc + (e.amount || 0), 0);
  }, [categories, sections, section]);

  return (
    <div className="SectionComponent">
      <div className="sectionInfo">
        <button onClick={onClickRemove}>-</button>
        <input
          placeholder="name"
          value={nameInput}
          onChange={(e) => {
            const { value } = e.target;
            setNameInput(value);
            submit({ name: value });
          }}
        />
        <div className="currentTotal">{numberToCommaString(currentTotal)}</div>
        <span> / </span>
        <input
          value={capacityInput}
          onKeyPress={(e) => !/[0-9.-]/.test(e.key) && e.preventDefault()}
          onChange={(e) => {
            const { value } = e.target;
            setCapacityInput(value);
            submit({ capacity: { [selectedInterval]: +value } });
          }}
          onFocus={(e) => setCapacityInput(e.target.value.replaceAll(",", ""))}
          onBlur={(e) => setCapacityInput(numberToCommaString(+e.target.value || 0))}
        />
      </div>
      <div className="children">
        <div>Categories:</div>
        <div>
          <button onClick={onClickAdd}>+</button>
        </div>
        <div>{categoryComponents}</div>
      </div>
    </div>
  );
};

export default SectionComponent;
